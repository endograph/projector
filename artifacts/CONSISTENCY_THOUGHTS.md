# Consistency Thoughts

These notes sketch an opt-in revision consistency surface for projector. The
goal is to let applications enforce their own revision semantics without making
projector own revision ids, database head pointers, conflict policy, or retry
behavior.

## Motivation

Projector frames are durable work products. A frame may be produced from a
machine snapshot that is no longer the current application head by the time the
frame is committed. Some apps are fine with that. Others want compare-and-set
behavior such as:

- an instance row has a current `revisionId`;
- a generator starts from revision `rev-17`;
- the generator emits a frame that would mutate the instance;
- before commit, the app checks that the instance is still at `rev-17`;
- if the instance moved to `rev-18`, the frame is rejected as stale.

Projector should provide the control surface around frame basis and frame
acceptance. The application should provide the meaning of the basis and the
persistence rules.

## Proposed Surface

One possible shape:

```ts
machine.consistency: {
  captureBasis?(ctx): FrameBasis;
  validateFrame?(
    basis: FrameBasis | undefined,
    ctx: FrameAcceptanceContext,
  ): Promise<FrameAcceptance> | FrameAcceptance;
}
```

`FrameBasis` should be opaque to projector. It might be a revision id, a set of
instance head ids, a DB transaction token, or anything else the application can
compare later.

`captureBasis` records what the current machine or runtime work is based on.
For generated work, projector would propagate that basis onto frames emitted by
the activation. For direct command work, the basis might be captured at command
execution time.

`validateFrame` runs before projector accepts a frame into the machine, before a
host persists it, or both, depending on the chosen mode. Projector can give the
validator derived facts it already understands:

```ts
type FrameAcceptanceContext = {
  frame: FrameDraft | Frame;
  affectedInstances: string[];
  affectedStates: StateAddress[];
  machine: Machine;
};
```

The application can then compare the frame basis against its durable head state.
Projector does not need to know what a revision id is.

## Rejection Result

It may be enough for `validateFrame` to return more than a boolean:

```ts
type FrameAcceptance =
  | { accept: true }
  | {
      accept: false;
      reason: "stale" | "conflict" | "invalid" | string;
      mode?: "drop" | "inert" | "complete-activation";
      metadata?: Record<string, unknown>;
    };
```

This may make a separate `onRejectFrame` hook unnecessary. The validator is the
code that understands why the frame failed, so it can also choose the semantic
shape of that failure.

Reasons to keep rejection steering inside `validateFrame`:

- avoids splitting one decision across two hooks;
- lets apps distinguish stale state, domain conflicts, validation failures, and
  persistence conflicts;
- allows projector to apply simple common policies like dropping the frame,
  appending an inert conflict frame, or completing the activation as stale;
- keeps retry/re-run behavior app-owned instead of implicit.

If this grows too broad, the escape hatch is to keep `validateFrame` focused on
accept/reject and return a rejection event to the host. But the first design
should try the single-hook shape because rejection policy is usually coupled to
the validation reason.

## Default Rejection Behavior

Projector should not automatically re-run the generator that produced a rejected
frame. A stale frame is not necessarily recoverable by retrying:

- the right behavior may be silent drop;
- the app may want to surface a conflict;
- the app may want to merge or rebase;
- the app may want to schedule a fresh activation from the new head;
- the app may want to do nothing for low-value background work.

The safest default is:

1. do not fold the rejected frame;
2. if it belongs to an activation, mark that activation completed with a stale
   or conflict reason;
3. expose enough information for the host/app to enqueue follow-up work if it
   wants to.

## Pre-Acceptance vs Optimistic Acceptance

There are two useful consistency modes.

Strict mode validates before the frame enters the machine:

```ts
const result = await validateFrame(basis, ctx);
if (!result.accept) return result;
machine.enqueueFrame(frame);
```

This keeps the in-memory machine and durable store aligned, but it can add
latency to every frame. It also means validation must be available in the place
where frames are enqueued, which may be awkward for browser, realtime, or local
simulation hosts.

Optimistic mode accepts immediately, then reconciles after persistence:

```ts
const frame = machine.enqueueFrame(draft);
const result = await persistFrame(frame);
if (!result.accepted) {
  machine.rebaseFrom(authoritativeSnapshot);
}
```

This is attractive for interactive apps because the local machine can keep
moving while the database decides whether the frame is durable. It matches the
current demo-agent style: frames are accepted locally, and persistence failure
causes the worker to rebuild from Convex state.

The hard part is rollback. Projector currently has no surgical "remove this
frame and undo its effects" operation. Because frames can spawn, remove,
transition, update state, and schedule work, backing out one frame in place is
likely more complex than rebuilding from an authoritative prefix.

For optimistic consistency, the more idiomatic primitive is probably:

```ts
machine.replaceHistory({
  root,
  frames,
});
```

or:

```ts
machine.rebase({
  root: authoritativeRoot,
  frames: authoritativeFrames,
  pendingFrames?: localFramesToReplay,
});
```

The host can then discard rejected frames and recreate the machine from durable
state. Later, projector could support replaying selected local pending frames on
top of the new head, but that should be explicit and app-guided.

## Recommended Direction

Start with a small, explicit surface:

- opaque frame basis capture and propagation;
- `validateFrame` returning semantic accept/reject results;
- derived mutation targets in the validation context;
- no automatic generator re-run;
- no in-place frame eviction as the first rollback primitive.

For low-latency apps, support an optimistic host pattern by making machine
replacement/rebase ergonomic. That gives apps a clear way to recover from
post-persistence rejection without forcing every frame through a synchronous
validation gate.
