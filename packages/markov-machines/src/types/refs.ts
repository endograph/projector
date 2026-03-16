import type { StandardNodeConfig } from "../executor/types";

/**
 * JSON Schema type for serialized Zod schemas.
 */
export type JSONSchema = Record<string, unknown>;

/**
 * Unified registry reference for executors, tools, nodes, and transitions.
 */
export interface Ref {
  ref: string;
}

/**
 * Serializable node definition.
 * Used for inline node definitions in transitions or persistence.
 * Note: Inline node tools (which have execute functions) cannot be serialized.
 */
export interface SerialNode<S = unknown> {
  /** Original charter node name (preserved when inlined) */
  name?: string;
  instructions: string;
  validator: JSONSchema;
  transitions: Record<string, Ref | SerialTransition>;
  /** Tools as refs only - resolved from charter at deserialization */
  tools?: Record<string, Ref>;
  /** Commands as refs only - resolved from charter at deserialization */
  commands?: Record<string, Ref>;
  /** Optional initial state for this node */
  initialState?: S;
  /** Executor configuration for this node */
  executorConfig?: StandardNodeConfig;
}

/**
 * Serializable transition definition.
 * References a target node and optionally defines custom arguments.
 */
export interface SerialTransition {
  type: "serial";
  description: string;
  node: Ref | SerialNode;
  arguments?: JSONSchema;
}

/**
 * Serializable pack definition.
 * Used for inline pack definitions when a pack has been edited.
 * Tools/commands are stored as refs and resolved from charter at deserialization.
 */
export interface SerialPack {
  name: string;
  description: string;
  /** Static instructions string (dynamic functions are resolved at serialization time) */
  instructions?: string;
  validator: JSONSchema;
  /** Tools as refs - resolved from charter at deserialization */
  tools?: Record<string, Ref>;
  /** Commands as refs - resolved from charter at deserialization */
  commands?: Record<string, Ref>;
  /** Optional initial state */
  initialState?: unknown;
}

/**
 * Type guard for Ref
 */
export function isRef(value: unknown): value is Ref {
  return (
    typeof value === "object" &&
    value !== null &&
    "ref" in value &&
    typeof (value as Ref).ref === "string"
  );
}

/**
 * Type guard for SerialNode
 */
export function isSerialNode<S>(value: unknown): value is SerialNode<S> {
  return (
    typeof value === "object" &&
    value !== null &&
    "instructions" in value &&
    "validator" in value &&
    "transitions" in value
  );
}

/**
 * Type guard for SerialTransition
 */
export function isSerialTransition(value: unknown): value is SerialTransition {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as SerialTransition).type === "serial"
  );
}

/**
 * Type guard for SerialPack
 */
export function isSerialPack(value: unknown): value is SerialPack {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "description" in value &&
    "validator" in value &&
    !("ref" in value) // Distinguish from Ref
  );
}
