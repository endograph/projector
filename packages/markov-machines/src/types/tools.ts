import type { z } from "zod";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { MachineMessage } from "./messages.js";

/**
 * Context passed to tool execute functions.
 * S is the state type - could be node state or ancestor state depending on where the tool is defined.
 */
export interface ToolContext<S = unknown> {
  /** Current state */
  state: S;
  /** Update state with a partial patch */
  updateState: (patch: Partial<S>) => void;
  /** ID of the instance executing this tool */
  instanceId: string;
  /** Get messages from the conversation history that belong to this instance */
  getInstanceMessages: () => MachineMessage[];
}

/**
 * Tool definition.
 * S is the state type this tool operates on.
 */
export interface ToolDefinition<
  TInput = unknown,
  TOutput = unknown,
  S = unknown,
> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (
    input: TInput,
    ctx: ToolContext<S>,
  ) => Promise<TOutput> | TOutput;
  /** If true, tool execution ends the turn immediately (yields end_turn) */
  terminal?: boolean;
}

/**
 * Base tool definition type for storage.
 * Uses 'any' for input/output to allow heterogeneous tool collections.
 */
// Heterogeneous collections cannot preserve specific input/output types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition<S = unknown> = ToolDefinition<any, any, S>;

/**
 * Anthropic tool definition format for API calls.
 */
export type AnthropicToolDefinition = Tool;

/**
 * Anthropic built-in tool (server-side, no execute function).
 * Used for tools like web_search that Anthropic handles.
 */
export interface AnthropicBuiltinTool {
  type: "anthropic-builtin";
  name: string;
  /** The Anthropic tool type, e.g., "web_search_20250305" */
  builtinType: string;
}

/**
 * Type guard for AnthropicBuiltinTool.
 */
export function isAnthropicBuiltinTool(tool: unknown): tool is AnthropicBuiltinTool {
  return (
    typeof tool === "object" &&
    tool !== null &&
    "type" in tool &&
    (tool as AnthropicBuiltinTool).type === "anthropic-builtin"
  );
}

/**
 * Tool reply that returns separate messages for the user and the LLM.
 * The user message can be a plain string or a typed message M (which becomes an OutputBlock<M>).
 */
export interface ToolReply<M = unknown> {
  type: "tool_reply";
  /** Message for the user - string or typed app message */
  userMessage: string | M;
  /** Message for the tool result (what the LLM sees) */
  llmMessage: string;
}

/**
 * Type guard for ToolReply.
 */
export function isToolReply(value: unknown): value is ToolReply {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as ToolReply).type === "tool_reply"
  );
}

/**
 * Create a tool reply with separate messages for the user and the LLM.
 * @param userMessage - Message for the user (string or typed app message)
 * @param llmMessage - Message for the tool result (what the LLM sees)
 */
export function toolReply<M = unknown>(userMessage: string | M, llmMessage: string): ToolReply<M> {
  return { type: "tool_reply", userMessage, llmMessage };
}

