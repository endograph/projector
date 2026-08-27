# Agent streaming

How live assistant output travels from the model to every viewer of a shared
session, and why the persistence is shaped the way it is.

## Pipeline

```
AI SDK fullStream
  → executor text segments        (packages/aisdk-executor/src/executor.ts)
  → onStreamUpdate callbacks      (out-of-band; cumulative text + streamSeq)
  → streamWriter                  (convex/agent.ts — throttle, diff to deltas)
  → appendStreamDelta mutation    (convex/messages.ts — append-only rows)
  → streamText query              (per-message subscription in the client)
```

**Segments.** The executor consumes the AI SDK `fullStream` and opens one
segment per `text-start` part. Each segment gets its own message id, so a turn
that interleaves prose and tool calls (progress update → tool → answer)
produces distinct assistant messages in the order the user watched them
stream. `text-end` enqueues the completed segment as its own frame
immediately — before a following tool call can finish — so frame replay
preserves the observed order.

**streamWriter.** Stream callbacks are fire-and-forget from the executor's
point of view; the writer serializes them onto a single chained tail promise
(`tail = tail.then(drainAll)`) — one mechanism, no flags or polling. It keeps
only the newest snapshot per segment, caps writes at one per 250ms (4 fps),
and diffs each snapshot against the last persisted text so every write is a
small immutable delta, not a cumulative rewrite. `flush()` runs in the
action's `finally` and just awaits the tail. `drainAll` never rejects (both
mutation calls are individually guarded), so the chain cannot wedge.

**Deltas.** `appendStreamDelta` upserts the durable message row (created
`streaming` with empty content) and appends a `messageStreamDeltas` row. The
serialized writer guarantees arrival order; `streamSeq` is stored only as the
deterministic sort key for reads. On completion the frame-persistence pass
writes the full text onto the message row and deletes the deltas; the delta
table only ever holds in-flight tails.

## Read isolation

A delta lands every 250ms during a stream, so what that write invalidates is
the whole cost model. The queries are split so it invalidates almost nothing:

- `messages.list` — the transcript. No stream text, no viewer identity. Only
  re-runs when a row is created or settled.
- `messages.viewerActors` — who the caller is (GitHub actor + owned anonymous
  actor). Depends on the session doc and auth state only.
- `messages.streamText` — live text for one streaming message: durable
  content plus the concatenated delta tail. Each streaming `Message`
  component subscribes to its own; a delta write invalidates exactly this one
  small query per viewer.

## Failure handling

- **Model or tool throws:** the executor emits `error` stream updates for
  unenqueued segments; the writer's terminal path calls `markStreamFailed`,
  which folds the delta tail into `content` and settles the row.
- **Barge-in cancel:** same shape with `cancelled`; the partial text goes to
  the frame log marked interrupted, and hosts skip message persistence.
- **Hard death (action timeout, crash — no code runs):** when
  `appendStreamDelta` creates a streaming row it schedules
  `markStreamFailed` 15 minutes out — past the 10-minute action ceiling. A
  normally settled stream makes the reap a no-op; an orphaned row gets its
  text recovered, its state set to `error`, and its deltas deleted.

## Relation to @convex-dev/agent

The server side here is deliberately the same design as the agent component's
`DeltaStreamer`: append-only delta rows written by a throttled single-flight
writer, durable message settled at completion. We keep our own implementation
because the component's thread/message persistence would fight the frame log,
which is the framework's actual source of truth.

The one thing the component does that we deliberately don't: **client-side
cursor sync**. Its `syncStreams` query takes the last position a client has
seen and returns only newer deltas; clients accumulate text locally, so each
delta write costs O(1) reads per subscriber. Our `streamText` re-reads the
message's full delta tail on each invalidation — O(deltas-so-far) per tick.

That trade is intentional. Replies are capped at 4096 output tokens, so a
typical stream is under a minute (~120 deltas ≈ a few thousand tiny document
reads per viewer over the whole stream — noise). The cursor upgrade stays
cheap precisely because live text is already isolated in `streamText`: give
it an `afterSeq` arg and let `Message` accumulate in state. Nothing about the
schema, the writer, or the transcript query would change.

Revisit if any of these become true:

- streams routinely run past a couple of minutes;
- sessions regularly have many simultaneous viewers;
- Convex insights flag `messages.streamText` read bandwidth.
