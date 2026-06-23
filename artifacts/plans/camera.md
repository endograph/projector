# Demo Camera Implementation Plan

## Summary

Fix camera support in `apps/demo` and `apps/demo-agent` by restoring the LiveKit vision sampling path from the older implementation, adapting it to the current `@projectors/*` package layout, and adding a frontend preview tied to the actual local LiveKit camera track.

This plan is scoped to making camera work for the LiveKit realtime demo. It does not require the broader transient-frame framework proposal.

## Current State

- The LiveKit OpenAI realtime image patch already exists at `patches/@livekit%2Fagents-plugin-openai@1.0.40.patch`.
- The patch targets the GA realtime implementation used by `openai.realtime.RealtimeModel`.
- `apps/demo-agent` currently has no vision sampler.
- The old camera sampler lived at `apps/demo-agent/src/agent/vision.ts` in commit `81b25b4ea2cc61a2e27df09d4e161cd64e0098bb`.
- `apps/demo/src/voice/LiveVoiceClient.tsx` currently publishes camera only when `cameraEnabled && voiceEnabled`.
- The frontend currently has no visible local camera preview.

## Encoding Decision

Use `sharp` for server-side frame encoding.

`sharp` is already present in the install graph through LiveKit, and the old demo implementation used it successfully. The implementation should still declare `sharp` directly in `apps/demo-agent/package.json` because `apps/demo-agent` imports it directly; relying on a nested dependency would make the package boundary brittle.

## Demo Agent Changes

Add `apps/demo-agent/src/vision.ts`, adapted from the old implementation.

The module should:

- Import `llm` from `@livekit/agents`.
- Import video track types and helpers from `@livekit/rtc-node`.
- Use `VideoStream` to read frames from remote user camera tracks.
- Convert frames to RGBA with `VideoBufferType.RGBA`.
- Encode sampled frames as JPEG data URLs with `sharp`.
- Detect user camera tracks by `TrackKind.KIND_VIDEO` and `TrackSource.SOURCE_CAMERA`.
- Subscribe to `RoomEvent.TrackSubscribed`, `TrackUnsubscribed`, `TrackMuted`, and `TrackUnmuted`.
- Start sampling existing already-subscribed camera publications when attached.
- Keep only one active camera track at a time.
- Expose a handle:

```ts
export interface VisionSamplerHandle {
  stop(): Promise<void>;
  setMode(mode: "active" | "idle"): void;
}
```

Use these default sampler settings:

- `activeFps: 1`
- `idleFps: 1 / 3`
- `maxDimension: 1024`
- `jpegQuality: 92`
- `detail: "low"`

When a frame is sampled:

- Encode the latest frame as `data:image/jpeg;base64,...`.
- Get `agent._agentActivity?.realtimeLLMSession`.
- Copy the realtime `chatCtx`.
- Remove existing messages whose id starts with `camera_frame_`.
- Add a user message with:
  - id `camera_frame_${Date.now()}`
  - createdAt `0`
  - text `[Camera frame] Live snapshot from the user's camera.`
  - image content from `llm.createImageContent({ image: dataUrl, inferenceDetail: "low", mimeType: "image/jpeg" })`
- Call `realtimeSession.updateChatCtx(chatCtx)`.

Do not enqueue these camera frames into `machine.frames` in this first camera patch. That avoids persisting base64 images into Convex and avoids scheduling extra projector work.

## Demo Agent Wiring

Update `apps/demo-agent/src/agent.ts`:

- Import `attachVisionSampler`.
- Create the sampler after `session.start(...)`, when the realtime session is available.
- Stop the sampler when the LiveKit room disconnects.
- Stop the sampler in the same cleanup path as `liveKitExecutor.disconnect()`.
- Listen to `voice.AgentSessionEventTypes.UserStateChanged`:
  - `newState === "speaking"` -> `visionSampler.setMode("active")`
  - otherwise -> `visionSampler.setMode("idle")`

Add direct runtime dependencies to `apps/demo-agent/package.json`:

- `@livekit/rtc-node`
- `sharp`

Even though `sharp` is already installed transitively, keep it as an explicit direct dependency of `@projectors/demo-agent`.

## Prompt Changes

Update `apps/demo-agent/src/projector-demo.ts` so the model knows how camera snapshots arrive.

Add camera guidance to the main demo agent instructions:

```text
When camera mode is enabled, you may receive user messages prefixed with "[Camera frame]" and image content. These are live snapshots, not continuous video. Only mention visual details when relevant to the user's request, and only describe what is visible in the most recent snapshot.
```

Do not rely on the raw projected `agentControls` state alone for this instruction; explicit prompt text is clearer and matches the old behavior.

## Frontend LiveKit Publishing

Update `apps/demo/src/voice/LiveVoiceClient.tsx`:

- Publish microphone based only on `voiceEnabled`.
- Publish camera based only on `cameraEnabled`.
- Remove the current `cameraEnabled && voiceEnabled` gate.
- Use camera capture options:

```ts
{
  resolution: { width: 1280, height: 720 },
  frameRate: 30,
}
```

Add a prop:

```ts
onLocalCameraTrackChange?: (track: LocalVideoTrack | null) => void;
```

Track the local camera publication:

- After successful `setCameraEnabled(true, ...)`, get the returned publication or `room.localParticipant.getTrackPublication(Track.Source.Camera)`.
- If it has a video track, call `onLocalCameraTrackChange(track)`.
- On `RoomEvent.LocalTrackPublished`, if source is camera, call `onLocalCameraTrackChange(publication.track ?? null)`.
- On `RoomEvent.LocalTrackUnpublished`, if source is camera, call `onLocalCameraTrackChange(null)`.
- On camera disable, disconnect, session change, or component cleanup, call `onLocalCameraTrackChange(null)`.

## Frontend Preview

Update `apps/demo/app/HomeClient.tsx`:

- Add local state for the local camera track.
- Pass `onLocalCameraTrackChange={setLocalCameraTrack}` to `LiveVoiceClient`.
- Pass `localCameraTrack` into `TerminalPane`.

Update `apps/demo/app/components/terminal/TerminalPane.tsx`:

- Accept `localCameraTrack?: LocalVideoTrack | null`.
- Render a compact 16:9 preview when `cameraEnabled` or `localCameraTrack` is present.
- Use a small `CameraPreview` component that attaches and detaches the track:

```tsx
useEffect(() => {
  if (!track || !videoRef.current) return;
  track.attach(videoRef.current);
  return () => {
    if (videoRef.current) track.detach(videoRef.current);
  };
}, [track]);
```

Preview states:

- Track present: show the live video.
- Camera enabled but no track yet: show a small connecting/permission state.
- Camera disabled: render nothing.

Keep the preview in the terminal pane header or just below it, not in the message list, so it does not look like durable chat history.

## Verification

Run:

```sh
bun run --filter @projectors/demo-agent typecheck
bun run --filter @projectors/demo typecheck
bun run --filter @projectors/livekit-realtime-executor typecheck
```

Manual verification:

1. Start the Convex/dev app and LiveKit agent.
2. Enable LiveKit transport or voice enough to connect the room.
3. Toggle camera on with voice off.
4. Confirm browser permission prompt appears if needed.
5. Confirm a local camera preview appears.
6. Confirm the browser publishes a local camera track.
7. Confirm `apps/demo-agent` logs that camera sampling started.
8. Enable voice and ask what the agent sees.
9. Confirm the agent can answer from image content.
10. Toggle camera off.
11. Confirm preview clears and sampler stops.

## Acceptance Criteria

- Camera can be enabled independently from microphone.
- Frontend preview shows the actual local LiveKit camera track.
- Demo agent receives sampled image snapshots in LiveKit realtime chat context.
- Camera snapshots do not persist as Convex machine frames or terminal messages.
- Existing text and voice flows continue to work.

## Assumptions

- The existing LiveKit patch remains the right patch for `@livekit/agents-plugin-openai@1.0.40`.
- `openai.realtime.RealtimeModel` continues to resolve to the GA realtime implementation, not beta.
- The first fix is realtime-only; discrete text/worker vision support will be handled by the transient-frame proposal.
