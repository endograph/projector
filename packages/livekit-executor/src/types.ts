/**
 * Types for LiveKitExecutor
 */

import type { voice } from "@livekit/agents";

/**
 * Configuration for LiveKitExecutor.
 */
export interface LiveKitExecutorConfig {
  /** Enable debug logging */
  debug?: boolean;
  /**
   * When true, primary nodes delegate inference to LiveKit voice agent.
   * When false, primary nodes use StandardExecutor (same as worker nodes).
   * This allows the same agent to handle both live voice and text-only modes.
   */
  isLive?: boolean;
  /** Anthropic API key for StandardExecutor (used for text mode and worker nodes) */
  apiKey?: string;
  /** Model to use for StandardExecutor */
  model?: string;
  /** Max tokens for StandardExecutor */
  maxTokens?: number;
}

/**
 * Configuration for connecting the executor to a machine.
 */
export interface ConnectConfig {
  /** The LiveKit voice agent session */
  session: voice.AgentSession;
  /** The LiveKit voice agent instance */
  agent: voice.Agent;
  /** The LiveKit room context */
  room: { name?: string };
}

/**
 * Tool definition in LiveKit format (JSON schema based).
 */
export interface LiveKitToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}
