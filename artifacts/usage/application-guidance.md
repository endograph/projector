# Application Usage Guidance

These notes capture application-development guidance learned while building the
demo app. They are not demo-specific rules. They are intended for future apps
that combine projector state, durable storage, streaming model output, and live
agent transports.

## Durable Truth

Treat the application database as the durable semantic source of truth. Runtime
transports such as browser connections, LiveKit rooms, OpenAI realtime sessions,
provider sockets, and worker processes should be reconstructable from durable
state.

Good durable state records:

- the current head frame
- branch root and ancestor frame path
- the latest projector instance for the current branch
- completed user and assistant messages
- enough sync/client residue to resume command processing

Runtime state can reconnect, restart, or be replaced. It should not be the only
place that knows what the app is doing.

## Frame-Based State

Use frame-oriented persistence for projector applications.

Recommended shape:

- a session row with `headFrameId`, `branchRootFrameId`, and ordered branch ancestors
- a frame table for actor/executor frames
- an instance log keyed by session/frame for the latest serialized projector instance
- a message table for user-visible conversation records
- a branch/message index if branch-aware reads need to stay cheap

Do not treat every user-visible message update as a projector state transition.
Frames should represent meaningful semantic work. UI patches, typing states, and
streaming deltas can live outside the durable frame log until finalization.

## Apply Against The Latest Head

Avoid APIs that accept and write a whole projector instance from a caller-owned
snapshot. Those APIs are easy to call with stale state and can revert newer
client commands.

Prefer mutations/actions that:

- load the latest durable session head inside the server boundary
- apply the user message or client command there
- append the resulting frame or instance log
- return only the small result the caller needs

This prevents bugs where a long-running action, worker, or browser snapshot
overwrites a newer command like enabling live mode.

## Streaming Output

Streaming should be as parallel as possible to core projector behavior.

Do not append a durable projector frame for every token or text delta. That
backpressures provider streaming on database writes and turns visible stream
cadence into mutation latency.

Preferred pattern:

- stream intermediate text to a lightweight message/UI path
- patch the same logical message using a stable idempotency key
- include a monotonic sequence number so late patches cannot overwrite newer content
- append one durable assistant frame when final content is complete

This keeps the UI responsive while preserving a clean durable frame log.

## Message Idempotency

Use idempotency keys for message writes, especially when streaming or receiving
events through reconnectable transports.

Useful key sources:

- provider message IDs
- framework message IDs
- stable generated activation/message IDs
- a fallback from timestamp plus text when no better source exists

Random keys are acceptable as a last resort, but they turn retries into
duplicates. Prefer deterministic keys whenever a logical message can be updated.

## History Rehydration

Workers should rebuild model history from durable completed messages and frames.
Do not feed incomplete streaming messages back into model history after restart.

On worker start:

- load the session associated with the runtime transport
- restore the serialized projector instance
- load persisted messages
- filter out empty or incomplete streaming records
- sort history by creation time

This keeps restarted workers from hallucinating context out of half-written UI
state.

## Client-Side Projector State

Do not store session-specific command transport in module-level mutable globals.
Browser remounts, hot reloads, route changes, and multiple mounted clients can
clear or corrupt shared state.

Prefer a session-scoped provider that owns:

- the optimistic effigy/client object
- current `sessionId`
- current send/action function
- snapshot and command-residue synchronization
- pending optimistic overlay cleanup on session changes

The provider can keep stable refs across renders while still being owned by the
mounted React tree that uses it.

## Manual Regression Checks

For future apps with live workers and voice/streaming:

- create a new session
- send through the durable HTTP/action path
- send through the live transport path
- toggle live/realtime mode before and after sends
- verify streaming is fast and final output is durable
- kill and restart the worker without creating a new session
- verify the worker reconstructs history and resumes cleanly

The important invariant is that runtime recovery must not require throwing away
the durable application session.
