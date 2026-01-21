import { v4 as uuid } from "uuid";
import { z } from "zod";
import type { Charter } from "../types/charter.js";
import type { Node } from "../types/node.js";
import type {
  Transition,
  TransitionContext,
  TransitionResult,
} from "../types/transitions.js";
import { transitionTo } from "../types/transitions.js";
import type { SerialNode, Ref } from "../types/refs.js";
import {
  isCodeTransition,
  isGeneralTransition,
} from "../types/transitions.js";
import { isRef, isSerialTransition } from "../types/refs.js";
import { resolveTransitionRef } from "./ref-resolver.js";
import type { AnyToolDefinition } from "../types/tools.js";

/**
 * Execute a transition and return the result.
 * S is the source state type.
 */
export async function executeTransition<S>(
  charter: Charter,
  transition: Transition<S>,
  state: S,
  reason: string,
  args: unknown,
): Promise<TransitionResult> {
  const ctx: TransitionContext = { args, reason };

  // Resolve ref to actual transition
  const resolved = resolveTransitionRef(charter, transition);

  // Code transition - execute
  if (isCodeTransition<S>(resolved)) {
    return resolved.execute(state, ctx);
  }

  // General transition - deserialize inline node
  if (isGeneralTransition(resolved)) {
    const nodeArg = args as { node?: SerialNode<unknown> };
    if (!nodeArg?.node) {
      throw new Error("General transition requires a node argument");
    }
    return transitionTo(deserializeNode(charter, nodeArg.node));
  }

  // Serial transition - resolve node ref or deserialize inline
  if (isSerialTransition(resolved)) {
    if (isRef(resolved.node)) {
      const node = charter.nodes[resolved.node.ref];
      if (!node) {
        throw new Error(`Unknown node ref: ${resolved.node.ref}`);
      }
      // Cast needed because charter.nodes contains nodes with any output type
      return transitionTo(node as Node<unknown, never>);
    }
    return transitionTo(deserializeNode(charter, resolved.node));
  }

  const typeInfo =
    typeof resolved === "object" && resolved !== null
      ? `object with keys: ${Object.keys(resolved).join(", ")}`
      : typeof resolved;
  throw new Error(`Unknown transition type: ${typeInfo}`);
}

/**
 * Deserialize a SerialNode into a Node.
 * Resolves transition refs from the charter.
 * Note: Inline node tools cannot be serialized and will be empty on deserialization.
 */
export function deserializeNode<S>(
  charter: Charter,
  serialNode: SerialNode<S>,
): Node<S> {
  // Deserialize the JSON Schema validator back to a Zod schema.
  const validator = z.fromJSONSchema(serialNode.validator) as z.ZodType<S>;

  // Resolve transition refs
  // Charter registry stores Transition<any> since it holds transitions for nodes
  // with different state types. Cast is required when assigning to typed record.
  const transitions: Record<string, Transition<S>> = {};
  for (const [name, trans] of Object.entries(serialNode.transitions)) {
    if (isRef(trans)) {
      const resolved = charter.transitions[trans.ref];
      if (!resolved) {
        throw new Error(`Unknown transition ref in inline node: ${trans.ref}`);
      }
      transitions[name] = resolved as unknown as Transition<S>;
    } else {
      transitions[name] = trans as Transition<S>;
    }
  }

  // Resolve tool refs from charter
  const tools: Record<string, AnyToolDefinition<S>> = {};
  if (serialNode.tools) {
    for (const [name, toolRef] of Object.entries(serialNode.tools)) {
      const resolved = charter.tools[toolRef.ref];
      if (!resolved) {
        throw new Error(`Unknown tool ref in inline node: ${toolRef.ref}`);
      }
      tools[name] = resolved as AnyToolDefinition<S>;
    }
  }

  return {
    id: uuid(),
    instructions: serialNode.instructions,
    tools,
    validator,
    transitions,
    initialState: serialNode.initialState,
  };
}

/**
 * Resolve a node reference or return the inline node.
 */
export function resolveNodeRef<S>(
  charter: Charter,
  nodeRef: Ref | SerialNode<S>,
): Node<S> {
  if (isRef(nodeRef)) {
    const node = charter.nodes[nodeRef.ref];
    if (!node) {
      throw new Error(`Unknown node ref: ${nodeRef.ref}`);
    }
    return node as Node<S>;
  }
  return deserializeNode(charter, nodeRef);
}
