# Demo App Learnings

Messy append-only notes extracted from recent sessions around `apps/demo`,
`apps/demo-agent`, LiveKit, streaming, voice, and durable projector state.

Last reviewed: 2026-06-13.

## 2026-06-12/13 Session Harvest

Primary sources were recent Codex session logs under:

- `/Users/zack/.codex/sessions/2026/06/12`
- `/Users/zack/.codex/sessions/2026/06/13`

The highest-signal sessions covered:

- Convex `$schema` failures during demo session creation.
- Demo DB refactor from turns/steps to frames.
- AI SDK executor and demo-agent integration.
- LiveKit data-channel text transport.
- Worker leases and duplicate LiveKit agent handling.
- `liveMode` stale-state regressions.
- Streaming slowness from durable writes per delta.
- Voice restart failures caused by LiveKit `RoomIO` participant binding ordering.
- Realtime VAD/noise-reduction tuning.
- Session-scoped projector client state via `ProjectorProvider`.

## Durable Projector State

The demo should treat Convex as the durable source of truth. LiveKit rooms,
OpenAI realtime sessions, browser connections, and executor sockets are runtime
transport details. They can reconnect or restart, but the semantic state should
come from the Convex frame/session log.

The current durable model is frame-based:

- `sessions.headFrameId`
- `sessions.branchRootFrameId`
- `sessions.branchAncestors`
- `machineFrames`
- `projectorInstanceLog`
- `messages`
- `messageIndex`

The old `machineTurns` / `machineSteps` vocabulary was removed from the demo.
Messages now point at frames, and branch indexing uses `branchRootFrameId`.

Important implementation split:

- `machineFrames` records actor/executor frames and advances `session.headFrameId`.
- `projectorInstanceLog` records the latest projector instance after a message or client command.
- `sessions.get` reconstructs the current instance by selecting the latest instance log on the current branch ancestor path.

This matters because not every UI-visible message or stream patch should become
a projector frame. Durable projector frames should represent meaningful machine
state transitions, not every token/delta.

## Convex `$schema` Boundary

Convex rejects field names beginning with `$`. This applies to documents,
mutation/action arguments, and function return values. It is not enough to
escape inside a mutation handler if the raw value is passed as a mutation arg,
because Convex validates args before the handler runs.

Learned fixes:

- Escape JSON-schema-bearing values before crossing any Convex action-to-mutation or external-client mutation boundary.
- Restore escaped values for server-side logic before running projector behavior.
- Strip schema metadata from browser-facing query results when the UI does not need it.
- Do not return full schema-bearing snapshots from actions.

Current helper lives in `apps/demo/convex/convexJson.ts`.

Values that commonly need care:

- serialized projector `instance`
- `clientSnapshot`
- `displayInstance`
- frame `metadata`
- frame `messages`
- `syncState`
- projected command/state schemas with `$schema` or `inputSchema`

Durable serialized instances should ideally be refs to registered nodes, for
example `node:demoRoot`, so they do not carry full JSON Schema by accident.
Client snapshots can still contain schemas for UI metadata, so the Convex
boundary still needs escaping/stripping.

## Avoid Stale Whole-Instance Writes

One failure mode: enabling `liveMode`, then sending a message, reverted
`liveMode` back to false.

Root cause: a send path processed against a stale action/client snapshot and
wrote a whole new projector session state derived from the old instance.

The fix was to remove broad "write this whole instance" paths and route message
or client-command updates through Convex mutations that read the latest head
frame at mutation time:

- `api.sessions.applyUserMessage`
- `api.sessions.applyClientMessage`

Those mutations:

- load the latest session head state from Convex
- apply the user message or client command
- append the resulting instance log / frame

Removed or avoided APIs:

- `updateProjectorSession`
- `updateInstance`
- `editCurrentInstance`
- `finalizeFrame`

Rule of thumb: message sends should apply to the latest durable head frame, not
to whatever snapshot the browser, action, or worker happened to have when the
request started.

## LiveKit Text Transport

LiveKit RPC was not reliable for this use case. It failed with `Method not
supported at destination`.

The working path is LiveKit data-channel messages:

- Browser publishes reliable data on topic `demo.message.v1`.
- Payload is JSON like `{ content, sentAt }`.
- `apps/demo-agent` listens for `RoomEvent.DataReceived`.
- Agent validates topic/payload and processes text through the same projector
  state and executor flow as other text sends.

Browser side details:

- Keep a sender function only when the room is connected and the worker is ready.
- When storing a sender function in React state, wrap the setter:
  `setSendLiveKitMessage(sender ? () => sender : null)`.
- Passing a function directly to a React setter causes React to call it as an updater. This produced empty `{ sentAt }` packets and hid the real sender.

Agent side details:

- Log entry start, room connection, loaded session, data topic/size, and processing start.
- Accept topicless packets only if the payload is otherwise valid, but ignore wrong non-empty topics.
- `LiveKit AgentSession` should use `inputOptions.closeOnDisconnect = false` so a browser reconnect does not close the whole agent session.

## LiveKit Text Is Not Automatically Voice

LiveKit transport and voice/realtime mode are separate toggles.

Important behavior:

- LiveKit data-channel text can be used while `liveMode` is false.
- If `liveMode` is false, the agent should not create/use realtime voice behavior for the reply.
- Text should run through the discrete AI SDK executor.
- `LiveKitExecutor` realtime delegation is gated by both `ENABLE_REALTIME_MODEL` and projected `agentControls.liveMode`.

The current `handleLiveKitTextMessage` path sends text through:

- `liveKitExecutor.run(...)` when `isLiveMode()` is true
- `agentDiscreteExecutor.run(...)` when `isLiveMode()` is false

This lets the Dev tab switch message transport between Convex and LiveKit
without forcing audio/realtime responses.

## Worker Dispatch And Leases

LiveKit can over-dispatch or leave multiple agent participants around. The
robust pattern is to let LiveKit be best-effort, but make Convex the authority
for which worker may mutate or run inference for a session.

Current table: `agentWorkerRooms`.

Important fields:

- `roomName`
- `agentDispatchId`
- `agentDispatchCreatedAt`
- `agentDispatchLockExpiresAt`
- `agentReconnectAttempt`
- `agentNextDispatchAt`
- `agentWorkerId`
- `agentWorkerLeaseToken`
- `agentWorkerLeaseExpiresAt`
- `agentWorkerHeartbeatAt`

Dispatch side:

- `getToken` / `ensureAgentDispatched` use stable room name `demo-${sessionId}`.
- `ensureAgentDispatchedImpl` claims an in-DB dispatch lock before creating or reconciling dispatches.
- It checks for an existing live worker lease before dispatching.
- It lists/removes duplicate LiveKit agent participants and duplicate dispatches best-effort.
- It uses backoff via `agentNextDispatchAt` / `agentReconnectAttempt`.

Worker side:

- On agent entry, claim `api.livekitAgent.claimAgentWorkerLease`.
- Heartbeat with `renewAgentWorkerLease` every few seconds.
- Subscribe to the room row and stop if the lease token or room changes.
- Assert/renew the lease before mutating Convex or running inference.
- Release the lease on disconnect.

Rule: only the lease holder may run the room machine loop or write frames/messages.

## Room Rotation Was A Trap

We tried rotating LiveKit room names on recovery. It addressed one symptom but
introduced reconnect churn:

- `getToken` rotated the room on every connection attempt.
- The client compared the new room against older Convex status.
- The client disconnected and retried.
- That caused connect/rotate/disconnect loops.

Final direction: keep stable room names (`demo-${sessionId}`) and fix the actual
LiveKit `RoomIO` participant ordering bug. Recovery should be dispatch/lease
based, not room-name churn.

## Voice Restart Failure And RoomIO Ordering

Hardest voice bug: first worker in a room could speak, but after restarting
`apps/demo-agent`, the new worker heard the user and got realtime transcripts /
metrics, yet produced no audible output.

Key diagnostic signal:

- Realtime `generation_created` appeared.
- User transcription completed.
- Realtime metrics completed.
- But no `local track published` / `local track subscribed` for output audio.

Likely root cause found in the session:

- `session.start()` creates LiveKit `RoomIO`.
- `RoomIO.start()` launches async `RoomIO.init()`.
- Our app had its own `ParticipantConnected` handler and called private `roomIO.setParticipant(...)`.
- That could race ahead of RoomIO's own participant handling.
- Input could work, but RoomIO output initialization could get stranded before publishing `roomio_audio`.

Settled fix:

- Keep using LiveKit RoomIO.
- Let RoomIO observe participant events first.
- Defer our participant rebinding with `queueMicrotask`.
- Initialize `activeVoiceParticipantIdentity` from existing participants before `session.start`.
- Pass `inputOptions.participantIdentity` when known.
- Use `participantKinds: [ParticipantKind.STANDARD]`.
- Keep `closeOnDisconnect: false`.

Important code comment from `apps/demo-agent/src/agent.ts`:

```ts
// RoomIO must observe participant events before we call its private setParticipant;
// otherwise its init task can wait forever and never publish the output audio track.
```

Keep passive diagnostics:

- `LocalTrackPublished`
- `LocalTrackSubscribed`
- agent state changes
- `SpeechCreated`
- realtime `generation_created`
- realtime input transcription completion
- realtime metrics
- session error events

Remove/avoid automatic watchdog recovery as a primary fix. Watchdogs can create
reconnect churn and hide the real LiveKit-level failure. The lease/dispatch
system should handle genuinely dead workers.

## Streaming Should Not Persist A Frame Per Delta

Streaming was painfully slow because each model delta was backpressured by
durable writes.

Bad pattern:

- For each AI SDK `textStream` delta, append a projector frame.
- Each frame append does Convex work and advances session head.
- Each delta waits for Convex before pulling the next provider delta.
- Visible streaming cadence becomes Convex mutation cadence.

Working pattern:

- Streaming deltas are out-of-band UI/message updates.
- Intermediate chunks call `onStreamUpdate`.
- `messages.add` patches a message by stable idempotency key.
- Only the final complete assistant message enqueues a projector frame.

Current guard:

- `messages.add` stores `streamSeq`.
- Existing message patches are ignored if the incoming `streamSeq` is older
  than the stored one.
- This prevents late/stale stream patches from overwriting final content.

Important distinction:

- Convex `messages` can show transient streaming text.
- Durable projector frames should wait for final assistant content.

The direct Convex `sessionActions.sendMessage` path was noted as non-streaming
at the time. The demo-agent path is where streaming was fixed first.

## Message Idempotency

For durable and streaming message writes, use idempotency keys.

Useful keys:

- `assistant:${messageId}`
- `user:${messageId}`
- fallback from createdAt/text where available
- random fallback only when no stable source exists

Idempotency is important because streaming updates patch the same logical
message repeatedly, and repeated LiveKit/browser sends should not create
duplicate visible rows where an update was intended.

## History Rehydration

On worker start:

- Load `getAgentInit` by room name.
- Restore the current projector instance.
- Load persisted messages.
- Convert persisted complete messages to actor history.

Streaming intermediate messages should not become model history. In the current
agent, `messagesToActorHistory` ignores messages with `streamState` that is not
`complete`.

This matters after restarts: the new worker should rebuild semantic context from
durable completed messages/frames, not from half-streamed UI text.

## Realtime / Voice Configuration

The demo-agent was too twitchy. Typing could trigger speech detection.

Current configurable knobs:

```bash
OPENAI_REALTIME_VAD_THRESHOLD=0.65
OPENAI_REALTIME_VAD_SILENCE_DURATION_MS=800
OPENAI_REALTIME_VAD_PREFIX_PADDING_MS=300
OPENAI_REALTIME_INPUT_NOISE_REDUCTION=near_field
```

Notes:

- Higher VAD threshold means audio must be louder to count as speech.
- Try `0.75` or `0.8` in noisy environments.
- `near_field` is better for close/headset mics.
- `far_field` is better for room/laptop mics.
- `off`, `none`, or `false` disables input noise reduction in current parsing.

Current realtime model setup:

- `OPENAI_REALTIME_MODEL` defaults to `gpt-realtime-2`.
- `OPENAI_REALTIME_VOICE` defaults to `alloy`.
- `inputAudioTranscription.model` is `whisper-1`.

## Projector Client State In React

Module-level mutable session transport caused `No active session` errors after
agent reconnect/remount.

Bad shape:

```ts
let currentSessionId = ...
let currentSendClientMessage = ...
const effigy = createMachineEffigy(async (message) => {
  if (!currentSessionId || !currentSendClientMessage) throw new Error("No active session");
  ...
});
```

Why it failed:

- old mounts, HMR, route transitions, or cleanup effects could clear shared module globals
- active UI still had a command path
- the command path read null global transport

Current better shape:

- `ProjectorProvider` owns session-scoped projector client state.
- It keeps one optimistic effigy per mounted provider tree.
- It stores `sessionId` and `sendClientMessage` in refs.
- It clears pending optimistic overlays when the session changes.
- Consumers use `useProjector()`.

Rule: context-scoped client object, not module singleton with global mutable
transport.

## Debugging Access

Local machine had Convex CLI/auth for the demo deployment.

Useful debugging commands from `apps/demo`:

- `bunx convex data --limit 1`
- `bunx convex function-spec`
- Convex deployment seen in session: `https://disciplined-bird-407.convex.cloud`

Treat DB writes/mutations as explicit-only during debugging.

## Practical Checks

Common verification commands used during these sessions:

```bash
bun run --filter @projectors/demo typecheck
bun run --filter @projectors/demo-agent build
bun run --filter @projectors/aisdk-executor typecheck
bun run --filter @projectors/aisdk-executor test
bun run --filter @projectors/livekit-executor typecheck
bun run --filter @projectors/livekit-executor test
```

ESLint note: at one point `apps/demo` had ESLint 9 but no flat
`eslint.config.*`, so lint did not run cleanly.

## Manual Voice Restart Regression

The important manual regression for reliable voice:

1. Start demo app and `apps/demo-agent`.
2. Create a session.
3. Enable LiveKit/live mode.
4. Speak once.
5. Confirm audible response.
6. Confirm agent logs `local track published` and `local track subscribed`.
7. Kill `apps/demo-agent`.
8. Restart `apps/demo-agent`.
9. Without creating a new session, speak again.
10. Confirm audible response and fresh local track publish/subscribe logs.
11. Send a LiveKit text message while live mode is on.
12. Confirm normal response and no reconnect loop.

Bad logs to watch for:

- repeated room-name changes for the same session
- infinite reconnecting loops
- repeated timeout/unhealthy-worker churn
- realtime generation with no local output track published in that worker lifecycle

## Current Mental Model

Durability:

- Convex frame/session/message tables are the source of truth.
- Provider sessions and LiveKit rooms are reconstructable runtime state.

Streaming:

- stream to `messages` for UI
- persist final assistant result as the projector frame
- guard updates with `streamSeq`

Voice:

- realtime is active only when projected `liveMode` says so
- LiveKit transport can carry text without realtime voice
- `RoomIO` participant ordering matters

Workers:

- LiveKit dispatch is best-effort
- Convex lease decides who can run and write
- stable room names plus lease/dispatch reconciliation beat room rotation

React client:

- projector command transport must be scoped to the mounted session provider
- no module-level mutable session globals
