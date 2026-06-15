# Idiomatic Usage: Threaded, Time-Travelable Agents

This document describes an idiomatic application architecture for building
threaded agents on top of the projection/frame runtime. It is app-level
guidance, not a core framework requirement.

The main pattern is to compose a running agent from two durable instance
dimensions:

- a shared base instance, usually scoped to a user, workspace, or agent profile;
- a thread-specific instance, scoped to one conversation branch.

The realized agent for a thread is the composition of both instances. The base
instance can evolve from any thread, and other running threads can ingest those
updates without treating them as new local work.

## Core Concepts

Use frames as the durable unit of thread history. A thread is a linear branch of
frames:

```ts
thread {
  branchRootFrameId,
  headFrameId?, // optional cache; latest frame for threadId can be the head
  threadInstanceId,
  baseInstanceId,
}
```

`headFrameId` is optional if the application invariant is:

- each branch has its own `threadId`;
- frames are append-only for that `threadId`;
- the current head is always the latest committed frame for that `threadId`;
- time travel creates a new thread/branch instead of moving an existing thread
  head backward.

Keeping `headFrameId` is still useful for compare-and-swap writes, efficient
head reads, pending/error states, and debugging. If present, prefer the name
`headFrameId` over `currentFrameId`.

Branches are identified by their first frame:

```ts
branchRootFrameId = first empty frame created for the branch
```

That frame gives the branch a durable identity even before user-visible content
exists.

## Instance Logs

It is useful to keep instance mutation logs separate from the broader thread
frame log. The broader frame log contains actor messages, tool messages, work
messages, and instance messages. The instance logs are materialized mutation
streams with snapshots after each instance message.

A simple Convex-style shape:

```ts
machineBaseInstanceLog {
  instanceId,
  frameId,
  message,  // InstanceMessage targeting this instance
  instance, // serialized instance after applying message
  createdAt,
}

machineThreadInstanceLog {
  instanceId,
  frameId,
  message,  // InstanceMessage targeting this instance
  instance, // serialized instance after applying message
  createdAt,
}
```

Separate base and thread logs are not required by the framework, but they make
application semantics easier to reason about:

- base instance updates are shared across threads that point at the same
  `baseInstanceId`;
- thread instance updates are private to one thread branch;
- branching a thread can duplicate only the thread instance while leaving the
  base pointer unchanged;
- simulation or development tools can fork the base instance independently.

The latest row for an `instanceId` is the canonical instance snapshot. A dense
numeric version is not required, but reads and subscriptions need stable append
order. Do not rely only on wall-clock time if ties are possible. Use an ordered
document id, `_creationTime` plus id, `createdAt` plus `frameId`, or an explicit
sequence if the application wants one.

## Canonical Instance Writes

When committing an instance mutation, the server should apply the incoming
`InstanceMessage` to the latest canonical snapshot in the database. Do not trust
a worker's local post-state as the canonical next state.

Preferred shape:

```ts
commitInstanceMessage(instanceId, frameId, message) {
  const latest = loadLatestInstance(instanceId);
  const next = applyInstanceMessage(latest.instance, message);
  insertLog({ instanceId, frameId, message, instance: next });
}
```

Avoid this shape:

```ts
insertLog({ instanceId, frameId, message, instance: workerLocalInstance });
```

The second shape can clobber another thread's update if the worker was running
against a stale base snapshot. Folding the message on the server keeps the
database canonical even when running workers drift slightly.

Applications that need stricter guarantees can add compare-and-swap checks,
expected head ids, leases, or conflict handling. The simple idiom is
last-committed-message-wins in stable append order.

## Ingesting Shared Base Updates

A running machine subscribed to a shared base instance should ingest new base
updates inertly:

```ts
machine.ingestInertFrame(frame)
```

The frame is folded into the local machine view. Its `InstanceMessage`s apply to
local state, and actor messages may become visible to future history if the app
uses inert actor frames. The frame does not trigger activations, does not call
local persistence hooks, and is not yielded as new local output.

This is the normal path for shared base propagation:

1. Thread A commits a base `InstanceMessage` to `machineBaseInstanceLog`.
2. Thread B is subscribed to rows for the same `baseInstanceId`.
3. Thread B receives the new row in durable append order.
4. Thread B calls `ingestInertFrame` with the committed frame/message.
5. Future inference in Thread B sees the updated base instance through normal
   projection.

Minor drift is acceptable in the idiomatic model. If Thread B is mid-inference
when Thread A updates the base, Thread B may finish that inference against the
older base view. The next inference should use the ingested base update.

## Thread Time Travel And Branching

Time travel should create a new branch rather than mutating old frames.

Thread branching at a frame:

1. Choose the branch point frame.
2. Create a new thread row.
3. Create an empty branch root frame for the new thread.
4. Copy or rebuild the user-visible message index up to the branch point.
5. Duplicate the thread instance snapshot from the branch point into a new
   `threadInstanceId`.
6. Set the new thread's `baseInstanceId`.

In the common case, the new branch keeps the same shared base pointer:

```ts
newThread.baseInstanceId = oldThread.baseInstanceId;
```

That means time travel is exact for the thread-local instance and message
history, while the base instance remains the current shared base.

If exact historical replay of the base is required, fork the base instance at
the branch point and point the new thread at that fork:

```ts
newThread.baseInstanceId = forkBaseInstanceAt(baseInstanceId, branchPoint);
```

Most applications do not need this for normal user-facing thread branching.

## Base Instance Branching

Base instance branching has two useful modes.

Thread-level base fork:

1. Branch the thread.
2. Duplicate the base instance snapshot into a new `baseInstanceId`.
3. Point the new thread at the duplicated base.

This makes the fork local to that thread branch.

User-level base fork:

1. Duplicate the base instance snapshot into a new `baseInstanceId`.
2. Set `user.baseInstanceId` to the duplicate.

This changes the user's default base for future work. Existing threads only see
the new base if they resolve through `user.baseInstanceId` dynamically or are
explicitly patched. If threads store `baseInstanceId`, changing the user pointer
affects new threads by default.

In practice, base branching is often a development, simulation, or evaluation
behavior. It may be acceptable for the agent worker to swap or modify a base
instance without representing every fork durably, as long as the app understands
that those runs are not fully replayable.

## Message Indexes

Keep user-visible messages separate from machine frames. Frames are runtime
history; messages are presentation records.

A branch-aware message index can be copied when creating a new branch:

```ts
messageIndex {
  threadId,
  branchRootFrameId,
  messageId,
  frameId,
}
```

For a new branch, copy entries up to the branch point. Future messages append to
the new branch's index. This keeps message listing cheap and avoids walking the
frame ancestry on every UI read.

## Frame Ancestry

Even if the current head is computed as the latest frame for a thread, store
enough ancestry to debug and reconstruct branches:

```ts
frame {
  threadId,
  frameId,
  parentFrameId?,
  branchRootFrameId,
  messages,
  createdAt,
}
```

`parentFrameId` is not required for every query, but it is valuable for replay,
inspection, branch visualization, and recovery.

## Practical Defaults

For a first implementation:

- use one `threadId` per branch;
- treat latest frame by stable append order as the branch head;
- store `headFrameId` only if compare-and-swap or fast coherent reads need it;
- store separate base and thread instance logs;
- commit instance messages by folding them onto the latest database snapshot;
- subscribe to the shared base log and apply updates with `ingestInertFrame`;
- branch threads by duplicating the thread instance at the branch point;
- keep base forks as explicit advanced behavior.

This keeps the framework semantics simple while giving applications room to add
stronger consistency, indexing, and simulation controls where needed.
