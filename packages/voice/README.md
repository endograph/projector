# @markov-machines/voice

Voice support for markov-machines using **LiveKit + OpenAI Realtime API**.

## Overview

This package provides `VoiceMachineRunner` as an alternative to `runMachine()` for voice mode. The key insight is that the instance tree and state machine semantics remain unchanged - we just swap the execution layer for the primary node while workers continue using the standard executor.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         VoiceMachineRunner                           │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                      Turn Coordinator                         │   │
│  │   ┌─────────────────┐         ┌─────────────────────────┐    │   │
│  │   │  Primary Node   │   +     │     Worker Leaves       │    │   │
│  │   │  (Realtime API) │         │   (StandardExecutor)    │    │   │
│  │   └────────┬────────┘         └───────────┬─────────────┘    │   │
│  │            └──────────┬───────────────────┘                   │   │
│  │                       ▼                                       │   │
│  │              Merged MachineStep                               │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌──────────────┐  ┌──────────────┐                                 │
│  │   LiveKit    │  │   OpenAI     │                                 │
│  │   Adapter    │◄─┤   Realtime   │                                 │
│  └──────────────┘  └──────────────┘                                 │
└─────────────────────────────────────────────────────────────────────┘
```

## Key Concepts

| Abstraction | Text Mode | Voice Mode |
|-------------|-----------|------------|
| Machine Runner | `runMachine()` | `voiceRunner.run()` |
| Primary Node | `executor.run()` | OpenAI Realtime via LiveKit |
| Workers | `executor.run()` with empty input | Same (unchanged) |
| Output | `AsyncGenerator<MachineStep>` | Same (unchanged) |

**Workers are fully compatible** - they use the standard executor regardless of voice/text mode.

## Installation

```bash
bun add @markov-machines/voice
```

## Prerequisites

1. **LiveKit Server** - Cloud or self-hosted ([livekit.io](https://livekit.io))
2. **OpenAI API Key** - With realtime API access
3. **Environment Variables**:
   ```bash
   OPENAI_API_KEY=sk-...
   LIVEKIT_URL=wss://your-app.livekit.cloud
   LIVEKIT_API_KEY=...
   LIVEKIT_API_SECRET=...
   ```

## Quick Start

```typescript
import { createVoiceMachineRunner } from "@markov-machines/voice";
import { createMachine, createCharter, createNode } from "markov-machines";

// 1. Create your machine (same as text mode)
const machine = createMachine(charter, {
  instance: createInstance(myNode, initialState),
});

// 2. Create the voice runner
const voiceRunner = createVoiceMachineRunner({
  openaiApiKey: process.env.OPENAI_API_KEY!,
  voice: "alloy",
  debug: true,
});

// 3. Subscribe to real-time events (for UI)
voiceRunner.on("speech_started", () => console.log("User speaking..."));
voiceRunner.on("speech_ended", (e) => console.log("User said:", e.transcript));
voiceRunner.on("response_started", () => console.log("Assistant responding..."));
voiceRunner.on("tool_call_started", (e) => console.log("Calling tool:", e.name));

// 4. Run the voice machine
const livekitOptions = {
  serverUrl: process.env.LIVEKIT_URL!,
  roomName: "my-room",
  token: await generateLiveKitToken(), // Your token generation logic
};

for await (const step of voiceRunner.run(machine, livekitOptions)) {
  // Same MachineStep as runMachine() - persist, update UI, etc.
  console.log("Turn complete:", step.messages.length, "messages");

  if (step.done) break;
}

await voiceRunner.stop();
```

## Full Example

See [examples/basic-usage.ts](./examples/basic-usage.ts) for a complete working example with:
- Node definition with voice-friendly instructions
- Tool definitions (addTodo, completeTodo)
- Event subscriptions for all voice events
- Main loop with step handling

## API Reference

### `createVoiceMachineRunner(config)`

Factory function that creates a `VoiceMachineRunner`.

```typescript
const voiceRunner = createVoiceMachineRunner({
  openaiApiKey: string,      // Required (used by LiveKit agents)
  model?: string,            // Default: "gpt-4o-realtime-preview-2024-12-17"
  voice?: VoiceId,           // "alloy" | "echo" | "shimmer" | etc.
  turnDetection?: {
    type: "server_vad",
    threshold?: number,      // 0.0-1.0, default 0.5
    silenceDurationMs?: number, // Default 500ms
  },
  debug?: boolean,           // Enable debug logging
});
```

### `VoiceMachineRunner`

```typescript
interface VoiceMachineRunner<AppMessage = unknown> {
  // Run the machine - yields MachineStep like runMachine()
  run(
    machine: Machine<AppMessage>,
    livekit: LiveKitOptions,
    options?: VoiceRunOptions<AppMessage>,
  ): AsyncGenerator<MachineStep<AppMessage>>;

  // Stop and disconnect
  stop(): Promise<void>;

  // Connection status
  readonly isConnected: boolean;

  // Subscribe to real-time events
  on<E extends VoiceEvent["type"]>(
    event: E,
    handler: (e: Extract<VoiceEvent, { type: E }>) => void,
  ): () => void; // Returns unsubscribe function

  // Get transcript history
  getTranscriptHistory(): Message<AppMessage>[];
}
```

### `LiveKitOptions`

```typescript
interface LiveKitOptions {
  serverUrl: string;  // "wss://your-app.livekit.cloud"
  roomName: string;   // Room to join
  token: string;      // JWT token for authentication
}
```

### Voice Events

Events emitted during a voice turn for real-time UI updates:

| Event | Payload | Description |
|-------|---------|-------------|
| `session_started` | `{ sessionId }` | Voice session connected |
| `speech_started` | `{}` | User started speaking |
| `speech_ended` | `{ transcript }` | User finished speaking |
| `response_started` | `{}` | Assistant started responding |
| `response_ended` | `{ transcript }` | Assistant finished responding |
| `tool_call_started` | `{ callId, name }` | Tool execution began |
| `tool_call_completed` | `{ callId, name, result }` | Tool execution finished |
| `state_updated` | `{ instanceId, state }` | State changed via tool |
| `interrupted` | `{}` | User interrupted the assistant |
| `error` | `{ error: Error }` | An error occurred |

## Implementation Notes

### Turn-Based Execution

Voice mode operates in "turns":
1. User speaks → VAD detects silence → transcript finalized
2. Assistant responds → response complete
3. Workers run via StandardExecutor
4. Results merged into `MachineStep`
5. Yield step, continue loop

### State Persistence

The same persistence code works for both text and voice modes:

```typescript
// Works identically for runMachine() and voiceRunner.run()
for await (const step of runner) {
  await db.saveStep({
    messages: step.messages,
    instance: serializeInstance(step.instance, charter),
    yieldReason: step.yieldReason,
    done: step.done,
  });
}
```

### Tool Execution

Tools defined on your nodes work automatically in voice mode:
- Tool schemas are converted to OpenAI function format
- Tool calls are executed via the same `ctx.updateState()` pattern
- State changes persist across turns

### Transitions

When a transition tool is called:
1. The voice session is reconfigured with the new node's instructions
2. New tools are registered
3. Conversation continues seamlessly

## Package Structure

```
packages/voice/
├── index.ts                 # Main exports
├── src/
│   ├── types.ts             # Type definitions
│   ├── voice-machine-runner.ts  # Main VoiceMachineRunner class
│   ├── realtime-client.ts   # LiveKit Agent wrapper
│   ├── livekit-adapter.ts   # LiveKit room connection
│   └── __tests__/           # Tests
└── examples/
    └── basic-usage.ts       # Full working example
```

## Troubleshooting

### "Room not initialized"
Call `liveKitAdapter.connect()` before starting the session.

### No audio from assistant
Check that your LiveKit token has the correct permissions for publishing audio.

### Tools not executing
Ensure your tool's `inputSchema` is a valid Zod schema - it's converted to JSON Schema for OpenAI.

### Turn never completes
The turn completes when the agent finishes speaking. Check `debug: true` for state transitions.

## Future Work

- [ ] Direct OpenAI Realtime connection (without LiveKit)
- [ ] Audio streaming events (`response_audio`)
- [ ] Nested instance state updates (workers, spawned children)
- [ ] Reconnection handling
