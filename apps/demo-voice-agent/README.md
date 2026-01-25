# Demo Voice Agent

LiveKit voice agent for the demo app. Supports two modes:

- **Realtime mode** (`ENABLE_REALTIME_MODEL=true`): Uses OpenAI Realtime API for low-latency voice-to-voice
- **Pipeline mode** (`ENABLE_REALTIME_MODEL=false`): Uses STT → LLM → TTS pipeline

## Setup

1. Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

2. Set your Convex deployment URL and create a `VOICE_AGENT_SECRET`:

```bash
# In Convex dashboard, add these environment variables:
# - LIVEKIT_API_KEY
# - LIVEKIT_API_SECRET
# - LIVEKIT_URL
# - VOICE_AGENT_SECRET (generate a random string)
```

3. Install dependencies:

```bash
bun install
```

4. Download required models (VAD, etc.):

```bash
bun run download-files
```

## Running

Development mode:

```bash
bun run dev
```

Production:

```bash
bun run build
bun run start
```

## Architecture

The agent:
1. Joins a LiveKit room when dispatched by the frontend
2. Listens to user audio and responds with voice
3. Persists transcripts to Convex via HTTP endpoint with idempotency

Transcripts are stored with idempotency keys (`{roomName}:{segmentId}:{role}`) to ensure exactly-once delivery even if the agent retries.
