/**
 * @markov-machines/voice
 *
 * Voice support for markov-machines using LiveKit + OpenAI Realtime API.
 * Provides VoiceMachineRunner as an alternative to runMachine() for voice mode.
 *
 * @example
 * ```typescript
 * import { createVoiceMachineRunner } from "@markov-machines/voice";
 *
 * const voiceRunner = createVoiceMachineRunner({
 *   openaiApiKey: process.env.OPENAI_API_KEY,
 *   voice: "alloy",
 * });
 *
 * // Subscribe to events
 * voiceRunner.on("speech_ended", (e) => console.log("User:", e.transcript));
 *
 * // Run the voice machine - yields MachineStep like runMachine
 * for await (const step of voiceRunner.run(machine, livekitOptions)) {
 *   // Persist steps, update UI, etc.
 *   if (step.done) break;
 * }
 * ```
 *
 * @packageDocumentation
 */

// Types
export type {
  VoiceRuntimeConfig,
  VoiceId,
  TurnDetectionConfig,
  LiveKitOptions,
  VoiceRunOptions,
  VoiceMachineRunner,
  VoiceEvent,
  VoiceTurnResult,
  RealtimeToolDefinition,
} from "./src/types.js";

// Main factory function
export { createVoiceMachineRunner } from "./src/voice-machine-runner.js";

// Components (for advanced usage)
export { LiveKitAdapter } from "./src/livekit-adapter.js";
export {
  RealtimeClient,
  type RealtimeEventCallback,
  type PendingFunctionCall,
  type TurnResult,
} from "./src/realtime-client.js";
