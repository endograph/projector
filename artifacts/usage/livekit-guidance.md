# LiveKit Usage Guidance

These notes capture LiveKit-specific guidance learned while building a durable
projector agent. They are intended for future apps that use LiveKit for text,
voice, or realtime agent transport.

## Treat LiveKit As Runtime Transport

LiveKit rooms, dispatches, participants, and agent processes are runtime state.
They can be duplicated, dropped, restarted, or reconnected. Durable semantic
state should live in the application database.

The LiveKit worker should be able to reconstruct its projector instance,
message history, and current instructions from durable state after restart.

## Text Transport

Use reliable LiveKit data-channel messages for app text transport.

Recommended pattern:

- browser publishes JSON payloads on an app-specific topic
- worker listens for `RoomEvent.DataReceived`
- worker validates topic and payload
- worker processes text through the same durable projector path as other sends

Avoid assuming LiveKit RPC is available across all participants/agents. In
practice, data-channel messages were simpler and more reliable for this app
shape.

When storing a LiveKit sender function in React state, wrap the setter:

```ts
setSender(sender ? () => sender : null);
```

Passing a function directly to a React state setter invokes it as an updater.
That can publish malformed packets and leave no usable sender stored.

## Text Transport Is Not Voice Mode

Do not conflate LiveKit transport with realtime voice mode.

LiveKit can carry text messages even when voice/realtime mode is disabled. In
that case, route the message through the discrete text executor and persist a
normal text response.

Realtime/voice delegation should be gated by application state, for example:

- feature flag or env var enables realtime support
- projected session state says live/voice mode is active

Only when both are true should the worker use realtime voice behavior for the
reply.

## Dispatch And Worker Leases

LiveKit can over-dispatch agents or leave duplicate participants/dispatches.
Use the application database as the authority for which worker may run semantic
work.

Recommended flow:

- client joins a stable room for the durable app session
- server records the room/session association
- server dispatches the named LiveKit agent best-effort
- worker claims an app-level lease before loading/running the session
- worker heartbeats the lease
- worker asserts the lease before inference and durable writes
- duplicate workers disconnect if they cannot claim the lease

Dispatch reconciliation should:

- avoid dispatching if a live worker lease exists
- hold an app-level dispatch lock while reconciling
- remove duplicate LiveKit agent participants best-effort
- remove duplicate/stale dispatches best-effort
- back off failed reconnect attempts

Only the lease holder should run the room's machine loop.

## Prefer Stable Room Names

Use stable room names derived from durable session identity, such as
`app-${sessionId}`.

Room rotation can create reconnect loops if token creation, status polling, and
client reconnect logic each observe different room names. Stable rooms plus
lease/dispatch reconciliation are easier to reason about.

Rotate rooms only for a proven LiveKit-level reason, and make room-name changes
explicit state transitions rather than side effects of every token request.

## RoomIO Participant Binding

Be careful when interacting with LiveKit Agents `RoomIO`, especially private
participant-binding APIs.

A subtle failure mode:

- the worker hears user audio
- realtime transcription and metrics complete
- realtime generation starts
- but no local output audio track is published/subscribed
- the user hears no response

One cause is racing LiveKit `RoomIO` initialization. If app code handles
participant events and calls private `roomIO.setParticipant(...)` before RoomIO
observes the same event, RoomIO's output initialization can get stranded.

Safer pattern:

- initialize the active participant identity from existing room participants
- pass `inputOptions.participantIdentity` to `session.start` when known
- set `participantKinds` to standard/user participants when appropriate
- use `closeOnDisconnect: false`
- let RoomIO observe participant events first
- defer app rebinding with `queueMicrotask`

Example shape:

```ts
const syncVoiceParticipant = () => {
  queueMicrotask(() => {
    bindVoiceParticipant(selectVoiceParticipantIdentity(room.remoteParticipants.values()));
  });
};
```

Keep a comment explaining that RoomIO must see participant events before private
rebinding, otherwise its init task may never publish the output audio track.

## Diagnostics

Keep passive diagnostics for voice and realtime sessions:

- agent entry start
- LiveKit room connection
- loaded durable session and message count
- data packet topic and size
- text processing start
- agent state changes
- speech creation
- local track published
- local track subscribed
- realtime generation created
- input transcription completed
- realtime metrics collected
- session errors

For restart failures, the key signal is whether the restarted worker logs a
fresh local output track publication/subscription before realtime responses.

Avoid relying on automatic watchdog recovery as the primary fix for audio
publication bugs. Watchdogs can create reconnect churn and obscure the ordering
or subscription issue. Use them sparingly after the underlying lifecycle is
understood.

## Realtime Audio Tuning

Expose realtime voice sensitivity as environment configuration.

Useful knobs:

```bash
OPENAI_REALTIME_VAD_THRESHOLD=0.65
OPENAI_REALTIME_VAD_SILENCE_DURATION_MS=800
OPENAI_REALTIME_VAD_PREFIX_PADDING_MS=300
OPENAI_REALTIME_INPUT_NOISE_REDUCTION=near_field
```

Guidance:

- raise VAD threshold in noisy environments
- try `0.75` or `0.8` if typing/background noise triggers speech
- use `near_field` for headset or close microphones
- use `far_field` for laptop/room microphones
- allow an explicit off/none/false value for local debugging

## Manual Regression

For any app using LiveKit voice workers:

1. Start the app and worker.
2. Create or open a durable session.
3. Join the LiveKit room.
4. Enable voice/realtime mode.
5. Speak once and confirm audible response.
6. Confirm local output track publication/subscription in worker logs.
7. Kill the worker.
8. Restart the worker.
9. Without creating a new durable session, speak again.
10. Confirm audible response and fresh output track logs.
11. Send a LiveKit text message while voice mode is active.
12. Confirm normal response and no reconnect loop.

Bad signs:

- room name changes repeatedly for one durable session
- token request triggers reconnect loops
- duplicate workers keep running semantic work
- realtime generation occurs without local output track publication
- stale workers continue writing after losing the lease
