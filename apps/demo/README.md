# demo

Projector demo app with text chat, projected state/commands, and LiveKit voice mode.

## Setup

Install workspace dependencies from the repo root:

```bash
bun install
```

Create `apps/demo/.env.local` with Convex and LiveKit values:

```bash
NEXT_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud
CONVEX_DEPLOYMENT=your-convex-deployment
LIVEKIT_API_KEY=your-livekit-api-key
LIVEKIT_API_SECRET=your-livekit-api-secret
LIVEKIT_URL=wss://your-project.livekit.cloud
```

Set the same LiveKit values in the Convex dashboard environment variables because `convex/livekitAgentActions.ts` mints room tokens and dispatches the agent from Convex.

## Run

Start Convex:

```bash
cd apps/demo
npx convex dev
```

Start the Next app in another terminal:

```bash
cd apps/demo
bun run dev
```

Open the printed Next URL, usually `http://localhost:3000`.

Voice mode also requires the worker from `apps/demo-agent` to be running. See `apps/demo-agent/README.md`.
