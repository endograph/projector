# demo-agent

LiveKit worker for the projector demo.

The web app dispatches this worker when the demo voice toggle is enabled. The worker joins the LiveKit room, starts an OpenAI Realtime session, syncs compiled projector instructions/tools through `@projectors/livekit-executor`, and persists voice transcripts back to the same Convex session used by text chat.

## Setup

Create `apps/demo-agent/.env`:

```bash
LIVEKIT_API_KEY=your-livekit-api-key
LIVEKIT_API_SECRET=your-livekit-api-secret
LIVEKIT_URL=wss://your-project.livekit.cloud
OPENAI_API_KEY=your-openai-api-key
CONVEX_URL=https://your-deployment.convex.cloud
ENABLE_REALTIME_MODEL=true
```

Optional:

```bash
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_REALTIME_VOICE=alloy
OPENAI_REALTIME_VAD_THRESHOLD=0.65
OPENAI_REALTIME_VAD_SILENCE_DURATION_MS=800
OPENAI_REALTIME_VAD_PREFIX_PADDING_MS=300
OPENAI_REALTIME_INPUT_NOISE_REDUCTION=near_field
```

For noisier rooms, raise `OPENAI_REALTIME_VAD_THRESHOLD` toward `0.8` so audio must be louder before it is treated as speech. Increase `OPENAI_REALTIME_VAD_SILENCE_DURATION_MS` if the agent cuts in too aggressively after brief pauses. Set `OPENAI_REALTIME_INPUT_NOISE_REDUCTION` to `near_field` for a headset/close mic, `far_field` for a room mic, or `off` to disable OpenAI input noise reduction.

The agent name is `demo-agent`; `apps/demo/convex/livekitAgentActions.ts` dispatches that exact name.

## Run

From this directory:

```bash
bun run dev
```

Then run the demo app and enable `voice` in the terminal toolbar. The browser will request a LiveKit token from Convex, join the room, and dispatch this worker.

For a production-style run:

```bash
bun run build
bun run start
```
