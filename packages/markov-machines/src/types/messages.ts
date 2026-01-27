import type { Command, Resume } from "./commands.js";
import type { Node } from "./node.js";
import type { SuspendInfo } from "./instance.js";
import type { StandardNodeConfig } from "../executor/types.js";

/**
 * Text content block (simplified for storage).
 */
export interface TextBlock {
  type: "text";
  text: string;
}

/**
 * Tool use content block (from assistant).
 */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/**
 * Thinking content block (simplified for storage).
 */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

/**
 * Tool result content block (in user message).
 */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * Output block from structured output.
 * Contains the mapped application message.
 * @typeParam M - The application message type (defaults to unknown).
 */
export interface OutputBlock<M = unknown> {
  type: "output";
  data: M;
}

// ============================================================================
// Instance Payloads - All instance mutations are modeled as messages
// ============================================================================

/**
 * State update payload - shallow merges patch into instance state.
 */
export interface StateUpdatePayload {
  kind: "state";
  instanceId: string;
  patch: Record<string, unknown>;
}

/**
 * Pack state update payload - shallow merges patch into pack state.
 */
export interface PackStateUpdatePayload {
  kind: "packState";
  packName: string;
  patch: Record<string, unknown>;
}

/**
 * Transition payload - replaces node/state, clears children.
 */
export interface TransitionPayload {
  kind: "transition";
  instanceId: string;
  node: Node<unknown, unknown>;
  state?: unknown;
  executorConfig?: StandardNodeConfig;
}

/**
 * Spawn payload - adds children to parent instance.
 */
export interface SpawnPayload {
  kind: "spawn";
  parentInstanceId: string;
  children: Array<{
    node: Node<unknown, unknown>;
    state?: unknown;
    executorConfig?: StandardNodeConfig;
  }>;
}

/**
 * Cede payload - removes instance from tree, optionally with content for parent.
 */
export interface CedePayload<M = unknown> {
  kind: "cede";
  instanceId: string;
  content?: string | MachineMessage<M>[];
}

/**
 * Suspend payload - marks instance as suspended.
 */
export interface SuspendPayload {
  kind: "suspend";
  instanceId: string;
  suspendInfo: SuspendInfo;
}

/**
 * Union of all instance mutation payloads.
 */
export type InstancePayload<M = unknown> =
  | StateUpdatePayload
  | PackStateUpdatePayload
  | TransitionPayload
  | SpawnPayload
  | CedePayload<M>
  | SuspendPayload;

/**
 * Union of all machine item types.
 * @typeParam M - The application message type for OutputBlock (defaults to unknown).
 */
export type MachineItem<M = unknown> =
  | TextBlock
  | ToolUseBlock
  | ThinkingBlock
  | ToolResultBlock
  | OutputBlock<M>
  | Command
  | Resume;

/**
 * Check if a machine item is an OutputBlock.
 */
export function isOutputBlock<M>(
  block: MachineItem<M>,
): block is OutputBlock<M> {
  return block.type === "output";
}

/**
 * Source attribution for a message.
 * - instanceId: ID of the instance that generated this message
 * - isPrimary: true if from the primary (non-worker) leaf instance
 * - external: true if message came from outside the machine (user transcript, LiveKit STT, etc.)
 */
export interface MessageSource {
  /** ID of the instance that generated this message */
  instanceId?: string;
  /** True if this message is from the primary (non-worker) leaf instance */
  isPrimary?: boolean;
  /** True if message originated from outside the machine (e.g., user speech, external system) */
  external?: boolean;
}

/**
 * @deprecated Use MessageSource instead
 */
export type SourceInstanceId = string | "user";

/**
 * Metadata attached to messages for attribution and tracking.
 */
export interface MessageMetadata {
  /** Source attribution for this message */
  source?: MessageSource;
  /** @deprecated Use source.instanceId instead */
  sourceInstanceId?: SourceInstanceId;
  /**
   * If true, this message is added to history for context but does not trigger
   * leaf execution (LLM inference). Use for logging/context messages that
   * should be visible to the LLM on the next real user message.
   */
  silent?: boolean;
}

/**
 * Base message with common fields.
 */
interface BaseMessage {
  /** Optional metadata for message attribution */
  metadata?: MessageMetadata;
}

/**
 * Conversation message (user, assistant, system, command).
 * @typeParam M - The application message type for OutputBlock (defaults to unknown).
 */
export interface ConversationMessage<M = unknown> extends BaseMessage {
  role: "user" | "assistant" | "system" | "command";
  items: string | MachineItem<M>[];
}

/**
 * Instance mutation message.
 * Contains a payload describing a state update, transition, spawn, cede, or suspend.
 * @typeParam M - The application message type (defaults to unknown).
 */
export interface InstanceMessage<M = unknown> extends BaseMessage {
  role: "instance";
  items: InstancePayload<M>;
}

/**
 * Message in the conversation history.
 * Can be a conversation message or an instance mutation message.
 * @typeParam M - The application message type for OutputBlock (defaults to unknown).
 */
export type MachineMessage<M = unknown> = ConversationMessage<M> | InstanceMessage<M>;

/**
 * Create a user message.
 * @param items - Message items (string or machine items)
 * @param metadata - Optional metadata (source attribution, silent flag, etc.)
 */
export function userMessage<M = unknown>(
  items: string | MachineItem<M>[],
  metadata?: MessageMetadata,
): MachineMessage<M> {
  return {
    role: "user",
    items,
    ...(metadata && { metadata }),
  };
}

/**
 * Create an assistant message.
 * @param items - Message items (string or machine items)
 * @param metadata - Optional metadata (source attribution, silent flag, etc.)
 */
export function assistantMessage<M = unknown>(
  items: string | MachineItem<M>[],
  metadata?: MessageMetadata,
): MachineMessage<M> {
  return {
    role: "assistant",
    items,
    ...(metadata && { metadata }),
  };
}

/**
 * Create a system message.
 * System messages are filtered from history before sending to the model.
 * Used for internal control flow like Resume.
 * @param items - Message items (string or machine items)
 * @param source - Optional source attribution for this message
 */
export function systemMessage<M = unknown>(
  items: string | MachineItem<M>[],
  source?: MessageSource,
): MachineMessage<M> {
  return {
    role: "system",
    items,
    ...(source && { metadata: { source } }),
  };
}

/**
 * Create a command message.
 * Command messages are processed with higher precedence than regular messages.
 * They are drained from the queue first and their results are yielded before
 * normal execution continues.
 * @param items - Message items (typically a Command object)
 * @param source - Optional source attribution for this message
 */
export function commandMessage<M = unknown>(
  items: string | MachineItem<M>[],
  source?: MessageSource,
): MachineMessage<M> {
  return {
    role: "command",
    items,
    ...(source && { metadata: { source } }),
  };
}

/**
 * Create an instance message.
 * Instance messages describe mutations to the machine's instance tree.
 * @param payload - The instance mutation payload
 * @param source - Optional source attribution for this message
 */
export function instanceMessage<M = unknown>(
  payload: InstancePayload<M>,
  source?: MessageSource,
): InstanceMessage<M> {
  return {
    role: "instance",
    items: payload,
    ...(source && { metadata: { source } }),
  };
}

/**
 * Create a tool result block.
 */
export function toolResult(
  toolUseId: string,
  content: string,
  isError?: boolean
): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
    ...(isError !== undefined && { is_error: isError }),
  };
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a message is a conversation message (user, assistant, system, command).
 */
export function isConversationMessage<M = unknown>(
  message: MachineMessage<M>,
): message is ConversationMessage<M> {
  return message.role !== "instance";
}

/**
 * Check if a message is an instance mutation message.
 */
export function isInstanceMessage<M = unknown>(
  message: MachineMessage<M>,
): message is InstanceMessage<M> {
  return message.role === "instance";
}

/**
 * Check if a message should be sent to the model (user or assistant only).
 */
export function isModelMessage<M = unknown>(
  message: MachineMessage<M>,
): message is ConversationMessage<M> {
  return message.role === "user" || message.role === "assistant";
}

/**
 * Extract text from a message's items.
 * Returns empty string for instance messages.
 */
export function getMessageText<M = unknown>(message: MachineMessage<M>): string {
  // Instance messages have no text content
  if (message.role === "instance") {
    return "";
  }
  if (typeof message.items === "string") {
    return message.items;
  }
  return message.items
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}
