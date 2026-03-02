import type { z } from "zod";
import type { CommandValueResult } from "./commands";
import type { ExternalizeStateConfig } from "./externalize";

/**
 * Context provided to pack tool and command execute functions.
 * Pack tools/commands only have access to pack state, not node state.
 */
export interface PackToolContext<S = unknown> {
  /** Current pack state */
  state: S;
  /** Update pack state with a partial patch */
  updateState: (patch: Partial<S>) => void;
  /** ID of the root instance in the ancestor chain (stable across child instances) */
  rootInstanceId?: string;
}

/**
 * Alias for PackToolContext - pack commands use the same context as pack tools.
 */
export type PackCommandContext<S = unknown> = PackToolContext<S>;

/**
 * Result of a pack command execution.
 * Can be a CommandValueResult with optional messages/payload, or void for silent updates.
 */
export type PackCommandResult<T = unknown> = CommandValueResult<T> | void;

/**
 * Pack command definition.
 * Commands bypass LLM and execute instantly with pack state access.
 */
export interface PackCommandDefinition<S = unknown, TInput = unknown, TOutput = unknown> {
  /** Command name (must be unique within the pack) */
  name: string;
  /** Description shown in command list */
  description: string;
  /** Zod schema for command input */
  inputSchema: z.ZodType<TInput>;
  /** Execute function - returns CommandValueResult for messages/payload, or void for silent updates */
  execute: (input: TInput, ctx: PackCommandContext<S>) => Promise<PackCommandResult<TOutput>> | PackCommandResult<TOutput>;
}

/**
 * Any pack command definition (erased input/output types).
 */
export type AnyPackCommandDefinition<S = unknown> = PackCommandDefinition<S, any, any>;

/**
 * Pack tool definition.
 * Similar to node tools but with pack-specific context.
 */
export interface PackToolDefinition<S = unknown, TInput = unknown, TOutput = unknown> {
  /** Tool name (must be unique within the pack) */
  name: string;
  /** Description shown to the agent */
  description: string;
  /** Zod schema for tool input */
  inputSchema: z.ZodType<TInput>;
  /** Execute function */
  execute: (input: TInput, ctx: PackToolContext<S>) => Promise<TOutput> | TOutput;
  /** If true, tool execution ends the turn immediately (yields end_turn) */
  terminal?: boolean;
}

/**
 * Any pack tool definition (erased input/output types).
 */
export type AnyPackToolDefinition<S = unknown> = PackToolDefinition<S, any, any>;

/**
 * Pack definition.
 * Packs are reusable modules with state and tools that can be applied to nodes.
 * Pack state is singleton - shared across all nodes that use the pack.
 */
export interface Pack<S = unknown> {
  /** Pack name (used for referencing) */
  name: string;
  /** Description shown in system prompt */
  description: string;
  /**
   * Optional instructions that are included in the system prompt when this pack is active.
   * Can be static text or derived from the current pack state.
   */
  instructions?: string | ((state: S) => string);
  /** Zod schema for pack state validation */
  validator: z.ZodType<S>;
  /** Pack tools (called by LLM) */
  tools: Record<string, AnyPackToolDefinition<S>>;
  /** Pack commands (called by user, bypass LLM) */
  commands?: Record<string, AnyPackCommandDefinition<S>>;
  /** Optional initial state */
  initialState?: S;
  /** Optional externalized state ownership hooks */
  externalize?: ExternalizeStateConfig<S>;
}

/**
 * Configuration for creating a pack.
 */
export interface PackConfig<S = unknown> {
  name: string;
  description: string;
  instructions?: string | ((state: S) => string);
  validator: z.ZodType<S>;
  tools?: Record<string, AnyPackToolDefinition<S>>;
  commands?: Record<string, AnyPackCommandDefinition<S>>;
  initialState?: S;
  externalize?: ExternalizeStateConfig<S>;
}

/**
 * Type guard for PackToolDefinition.
 */
export function isPackToolDefinition(value: unknown): value is AnyPackToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "description" in value &&
    "inputSchema" in value &&
    "execute" in value &&
    typeof (value as AnyPackToolDefinition).execute === "function"
  );
}

/**
 * Type guard for Pack.
 */
export function isPack(value: unknown): value is Pack {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "description" in value &&
    "validator" in value &&
    "tools" in value
  );
}
