import type { z } from "zod";
import type { Node } from "./node.js";
import type { MachineMessage } from "./messages.js";
import type {
  CedeResult,
  SpawnResult,
  SpawnTarget,
  SpawnOptions,
  TransitionToResult,
  SuspendResult,
} from "./transitions.js";

/**
 * Options for suspend helper in commands.
 */
export interface SuspendOptions {
  /** Custom suspend ID (auto-generated if not provided) */
  suspendId?: string;
  /** Optional metadata for application use */
  metadata?: Record<string, unknown>;
}

/**
 * Context passed to command execute functions.
 * S is the state type of the current node.
 */
export interface CommandContext<S = unknown> {
  /** Current state */
  state: S;
  /** Update state with a partial patch */
  updateState: (patch: Partial<S>) => void;
  /** ID of the instance executing this command */
  instanceId: string;
  /** Get messages from the conversation history that belong to this instance */
  getInstanceMessages: () => MachineMessage[];
  /** Cede control back to parent with optional content (string or MachineMessage[]) */
  cede: <M = unknown>(content?: string | MachineMessage<M>[]) => CedeResult<M>;
  /** Spawn one or more child instances */
  spawn: <T = unknown>(
    nodeOrTargets: Node<any, T> | SpawnTarget<T>[],
    state?: T,
    options?: SpawnOptions,
  ) => SpawnResult<T>;
  /** Suspend the current instance */
  suspend: (reason: string, options?: SuspendOptions) => SuspendResult;
}

/**
 * Command definition.
 * Commands are user-callable methods that bypass LLM inference.
 * S is the state type this command operates on.
 */
export interface CommandDefinition<
  TInput = unknown,
  TOutput = unknown,
  S = unknown,
> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (
    input: TInput,
    ctx: CommandContext<S>,
  ) => Promise<CommandResult<TOutput>> | CommandResult<TOutput>;
}

/**
 * Base command definition type for storage.
 * Uses 'any' for input/output to allow heterogeneous command collections.
 */
// Heterogeneous collections cannot preserve specific input/output types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommandDefinition<S = unknown> = CommandDefinition<any, any, S>;

/**
 * Resume result - command resumes the current instance from suspension.
 */
export interface ResumeResult {
  type: "resume";
}

/**
 * Standard command result - returns optional messages to enqueue and optional payload.
 */
export interface CommandValueResult<T = unknown> {
  type: "command_result";
  /** Messages to enqueue (user messages, assistant messages, etc.) */
  messages?: MachineMessage[];
  /** Optional payload/return value */
  payload?: T;
}

/**
 * Union of all command results.
 * Commands can return a result with messages/payload, transition, spawn, cede, suspend, or resume.
 */
export type CommandResult<T = unknown> =
  | CommandValueResult<T>
  | TransitionToResult
  | SpawnResult
  | CedeResult
  | SuspendResult
  | ResumeResult;

/**
 * Type guard for CommandValueResult.
 */
export function isCommandValueResult<T>(result: CommandResult<T>): result is CommandValueResult<T> {
  return (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    result.type === "command_result"
  );
}

/**
 * Helper to create a resume result.
 * Use this in command execute functions to resume the current instance.
 */
export function commandResume(): ResumeResult {
  return { type: "resume" };
}

/**
 * Helper to create a command result.
 * @param payload - Optional payload/return value
 * @param messages - Optional messages to enqueue
 */
export function commandResult<T = unknown>(
  payload?: T,
  messages?: MachineMessage[],
): CommandValueResult<T> {
  return { type: "command_result", messages, payload };
}

/**
 * Info about a command for frontend display.
 */
export interface CommandInfo {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

/**
 * Object representing a command invocation.
 * Can be passed to runMachine to execute a command directly without LLM inference.
 */
export interface Command {
  type: "command";
  name: string;
  input: unknown;
  /** Target specific instance (defaults to active instance) */
  instanceId?: string;
}

/**
 * Type guard for Command.
 */
export function isCommand(value: unknown): value is Command {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "command" &&
    "name" in value &&
    typeof value.name === "string"
  );
}

/**
 * Input to resume a suspended instance.
 * Can be passed to runMachine to resume execution.
 */
export interface Resume {
  type: "resume";
  /** Instance ID to resume */
  instanceId: string;
  /** Suspend ID that must match the instance's current suspension */
  suspendId: string;
}

/**
 * Type guard for Resume.
 */
export function isResume(value: unknown): value is Resume {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "resume" &&
    "instanceId" in value &&
    typeof value.instanceId === "string" &&
    "suspendId" in value &&
    typeof value.suspendId === "string"
  );
}

/**
 * Type guard for ResumeResult.
 */
export function isResumeResult(value: unknown): value is ResumeResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as ResumeResult).type === "resume"
  );
}

/**
 * Result of executing a command.
 */
export interface CommandExecutionResult<T = unknown> {
  success: boolean;
  value?: T;
  error?: string;
}
