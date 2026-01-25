import type {
  Machine,
  MachineStep,
  RunOptions,
  Message,
  Instance,
  YieldReason,
} from "markov-machines";

/**
 * Configuration for the voice machine runner.
 */
export interface VoiceRuntimeConfig {
  /**
   * OpenAI API key for Realtime API.
   * Note: When using LiveKit agents, the API key is typically configured
   * via environment variables (OPENAI_API_KEY) or LiveKit's plugin system.
   * This field is reserved for future direct OpenAI Realtime connections.
   */
  openaiApiKey: string;
  /** Voice model (default: "gpt-4o-realtime-preview-2024-12-17") */
  model?: string;
  /** Voice ID for TTS */
  voice?: VoiceId;
  /** Turn detection configuration */
  turnDetection?: TurnDetectionConfig;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Available voice IDs for OpenAI Realtime.
 */
export type VoiceId =
  | "alloy"
  | "ash"
  | "ballad"
  | "coral"
  | "echo"
  | "sage"
  | "shimmer"
  | "verse";

/**
 * Turn detection configuration for VAD.
 */
export interface TurnDetectionConfig {
  type: "server_vad";
  /** Activation threshold (0.0-1.0, default 0.5) */
  threshold?: number;
  /** Audio to include before speech (ms, default 300) */
  prefixPaddingMs?: number;
  /** Duration of silence to detect end of speech (ms, default 500) */
  silenceDurationMs?: number;
}

/**
 * LiveKit connection options.
 */
export interface LiveKitOptions {
  /** LiveKit server URL (wss://...) */
  serverUrl: string;
  /** Room name to join */
  roomName: string;
  /** Participant token (JWT) */
  token: string;
}

/**
 * Options for running the voice machine.
 */
export interface VoiceRunOptions<AppMessage = unknown> extends RunOptions<AppMessage> {
  /** Callback when transcript history updates */
  onTranscriptUpdate?: (history: Message<AppMessage>[]) => void;
}

/**
 * Voice Machine Runner - alternative to runMachine() for voice mode.
 * Yields MachineStep just like runMachine does.
 */
export interface VoiceMachineRunner<AppMessage = unknown> {
  /**
   * Run the machine with voice input.
   * Yields MachineStep after each voice turn + worker execution.
   */
  run(
    machine: Machine<AppMessage>,
    livekit: LiveKitOptions,
    options?: VoiceRunOptions<AppMessage>,
  ): AsyncGenerator<MachineStep<AppMessage>>;

  /**
   * Stop the voice session and disconnect.
   */
  stop(): Promise<void>;

  /**
   * Whether the runner is currently connected.
   */
  readonly isConnected: boolean;

  /**
   * Subscribe to real-time events (for UI updates during a turn).
   * Returns unsubscribe function.
   */
  on<E extends VoiceEvent["type"]>(
    event: E,
    handler: (e: Extract<VoiceEvent, { type: E }>) => void,
  ): () => void;

  /**
   * Get the accumulated transcript history.
   */
  getTranscriptHistory(): Message<AppMessage>[];
}

/**
 * Events emitted by the voice runtime for real-time UI updates.
 * These are separate from MachineStep - they happen during a turn.
 */
export type VoiceEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "speech_started" }
  | { type: "speech_ended"; transcript: string }
  | { type: "response_started" }
  | { type: "response_text"; text: string; delta: string }
  | { type: "response_audio"; audio: Uint8Array }
  | { type: "response_ended"; transcript: string }
  | { type: "tool_call_started"; callId: string; name: string }
  | { type: "tool_call_completed"; callId: string; name: string; result: string }
  | { type: "transition"; fromNode: string; toNode: string }
  | { type: "state_updated"; instanceId: string; state: unknown }
  | { type: "interrupted" }
  | { type: "error"; error: Error };

/**
 * Result of a voice turn (from OpenAI Realtime).
 * Internal type used to construct LeafResult.
 */
export interface VoiceTurnResult<AppMessage = unknown> {
  /** Instance ID for the primary node */
  instanceId: string;
  /** User's speech transcript */
  userTranscript: string;
  /** Assistant's response messages */
  messages: Message<AppMessage>[];
  /** Updated instance after tool calls/state updates */
  updatedInstance: Instance;
  /** Why the turn ended */
  yieldReason: YieldReason;
  /** Updated pack states */
  packStates?: Record<string, unknown>;
  /** Cede content if the node ceded */
  cedeContent?: string | Message<AppMessage>[];
  /** Whether a transition occurred */
  transitioned: boolean;
  /** Whether the turn was interrupted by the user */
  wasInterrupted?: boolean;
}

/**
 * OpenAI Realtime tool definition format.
 */
export interface RealtimeToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * OpenAI Realtime session configuration.
 */
export interface RealtimeSessionConfig {
  instructions: string;
  tools: RealtimeToolDefinition[];
  voice: VoiceId;
  turn_detection: TurnDetectionConfig | null;
  input_audio_format?: "pcm16" | "g711_ulaw" | "g711_alaw";
  output_audio_format?: "pcm16" | "g711_ulaw" | "g711_alaw";
}
