import type { Charter } from "../types/charter.js";
import type { Instance } from "../types/instance.js";
import type { Message } from "../types/messages.js";


/**
 * Reason why the executor yielded control.
 */
export type YieldReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "cede"
  | "suspend"          // Instance just suspended
  | "awaiting_resume"; // All leaves suspended, waiting for resume

/**
 * Options for executor run.
 * @typeParam AppMessage - The application message type for structured outputs (defaults to unknown).
 */
export interface RunOptions<AppMessage = unknown> {
  maxTurns?: number;
  /** Previous conversation history to include */
  history?: Message<AppMessage>[];
  /** Max execution steps (for cede continuation). Default 50. */
  maxSteps?: number;
  /** Current step number (1-indexed) */
  currentStep?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Result returned from executor run (single API call).
 * @typeParam AppMessage - The application message type for structured outputs (defaults to unknown).
 */
export interface RunResult<AppMessage = unknown> {
  /** Updated instance tree */
  instance: Instance;
  /** New messages from this turn */
  messages: Message<AppMessage>[];
  /** Why the run yielded */
  yieldReason: YieldReason;
  /** Content from cede - string or Message[] (only set when yieldReason is "cede") */
  cedeContent?: string | Message<AppMessage>[];
  /** Updated pack states (to be applied to root instance) */
  packStates?: Record<string, unknown>;
}

/**
 * Information about a suspended instance.
 */
export interface SuspendedInstanceInfo {
  instanceId: string;
  suspendId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

/**
 * A single step in machine execution.
 * Each step represents exactly one Claude API call or command execution.
 * @typeParam AppMessage - The application message type for structured outputs (defaults to unknown).
 */
export interface MachineStep<AppMessage = unknown> {
  /** Updated instance tree after this step */
  instance: Instance;
  /** Messages generated in this step */
  messages: Message<AppMessage>[];
  /** Why this step yielded */
  yieldReason: "end_turn" | "tool_use" | "cede" | "max_tokens" | "command" | "suspend" | "awaiting_resume";
  /** True if this is the final step (has response or hit limit) */
  done: boolean;
  /** Cede content if yieldReason is "cede" - string or Message[] */
  cedeContent?: string | Message<AppMessage>[];
  /** Info about suspended instances (when yieldReason is "suspend" or "awaiting_resume") */
  suspendedInstances?: SuspendedInstanceInfo[];
}

/**
 * Executor interface for running the agent loop.
 * Charter has a single executor that runs all nodes.
 * @typeParam AppMessage - The application message type for structured outputs (defaults to unknown).
 */
export interface Executor<AppMessage = unknown> {
  /** Executor type identifier */
  type: "standard";

  /**
   * Run the executor for a node instance.
   * @param charter - The charter (for ref resolution)
   * @param instance - The current node instance (may have ancestors)
   * @param ancestors - Parent instances for ref resolution (from root to parent)
   * @param input - User input message
   * @param options - Run options
   */
  run(
    charter: Charter<any>,
    instance: Instance,
    ancestors: Instance[],
    input: string,
    options?: RunOptions<AppMessage>,
  ): Promise<RunResult<AppMessage>>;
}

/**
 * Configuration for StandardExecutor constructor.
 */
export interface StandardExecutorConfig {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /** Enable debug logging for API requests/responses */
  debug?: boolean;
}

/**
 * Per-node executor configuration recognized by StandardExecutor.
 * These fields are validated at runtime.
 *
 * Usage in executorConfig:
 * - model: string - Model to use (e.g., "claude-3-haiku-20240307")
 * - maxTokens: number - Max tokens for response
 * - temperature: number - Temperature for generation (0-1)
 */
export interface StandardNodeConfig {
  /** Model to use for this node (e.g., "claude-3-haiku-20240307") */
  model?: string;
  /** Max tokens for response */
  maxTokens?: number;
  /** Temperature for generation (0-1) */
  temperature?: number;
}
