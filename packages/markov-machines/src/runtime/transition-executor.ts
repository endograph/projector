import { v4 as uuid } from "uuid";
import type { Charter } from "../types/charter.js";
import { fromSafeJsonSchema } from "../helpers/json-schema.js";
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
import type { AnyPackToolDefinition } from "../types/pack.js";

/**
 * Resolve a node tool ref (flat or dotted).
 * Flat: charter.tools[ref]. Dotted: charter.nodes[source].tools[name].
 * Does NOT search pack tools — use resolvePackToolRef for those.
 */
function resolveNodeToolRef(charter: Charter<any>, ref: string): AnyToolDefinition {
  const dotIdx = ref.indexOf(".");
  if (dotIdx === -1) {
    const tool = charter.tools[ref];
    if (!tool) throw new Error(`Unknown tool ref: ${ref}`);
    return tool;
  }
  const source = ref.slice(0, dotIdx);
  const name = ref.slice(dotIdx + 1);
  const node = charter.nodes[source];
  if (!node) throw new Error(`Unknown node in tool ref: ${ref}`);
  const tool = node.tools[name];
  if (!tool) throw new Error(`Unknown tool on node ${source}: ${name}`);
  return tool as AnyToolDefinition;
}

/**
 * Resolve a pack tool ref (flat or dotted).
 * Flat: charter.tools[ref] (charter tools are shared). Dotted: charter.packs by name.
 * Does NOT search node tools.
 */
export function resolvePackToolRef(
  charter: Charter<any>,
  ref: string,
): AnyToolDefinition | AnyPackToolDefinition {
  const dotIdx = ref.indexOf(".");
  if (dotIdx === -1) {
    const tool = charter.tools[ref];
    if (!tool) throw new Error(`Unknown tool ref: ${ref}`);
    return tool;
  }
  const source = ref.slice(0, dotIdx);
  const name = ref.slice(dotIdx + 1);
  const pack = charter.packs.find((p) => p.name === source);
  if (!pack) throw new Error(`Unknown pack in tool ref: ${ref}`);
  const tool = pack.tools[name];
  if (!tool) throw new Error(`Unknown tool on pack ${source}: ${name}`);
  return tool;
}

/**
 * Resolve a transition ref (flat or dotted).
 * Flat: charter.transitions[ref]. Dotted: charter.nodes[source].transitions[name].
 */
export function resolveNestedTransitionRef(
  charter: Charter<any>,
  ref: string,
): Transition<unknown> {
  const dotIdx = ref.indexOf(".");
  if (dotIdx === -1) {
    const t = charter.transitions[ref];
    if (!t) throw new Error(`Unknown transition ref: ${ref}`);
    return t;
  }
  const source = ref.slice(0, dotIdx);
  const name = ref.slice(dotIdx + 1);
  const node = charter.nodes[source];
  if (!node) throw new Error(`Unknown node in transition ref: ${ref}`);
  const t = node.transitions[name];
  if (!t) throw new Error(`Unknown transition on node ${source}: ${name}`);
  return t;
}

/**
 * Execute a transition and return the result.
 * S is the source state type.
 */
export async function executeTransition<S>(
  charter: Charter<any>,
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
      // charter.nodes uses `any` for state, so no cast needed
      return transitionTo(node);
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
  charter: Charter<any>,
  serialNode: SerialNode<S>,
): Node<never, S> {
  // Deserialize the JSON Schema validator back to a Zod schema.
  const validator = fromSafeJsonSchema<S>(serialNode.validator as Record<string, unknown>);

  // Resolve transition refs (supports dotted nested refs)
  const transitions: Record<string, Transition<S>> = {};
  for (const [name, trans] of Object.entries(serialNode.transitions)) {
    if (isRef(trans)) {
      transitions[name] = resolveNestedTransitionRef(charter, trans.ref) as unknown as Transition<S>;
    } else {
      transitions[name] = trans as Transition<S>;
    }
  }

  // Resolve tool refs (supports dotted nested refs — node tools only)
  const tools: Record<string, AnyToolDefinition<S>> = {};
  if (serialNode.tools) {
    for (const [name, toolRef] of Object.entries(serialNode.tools)) {
      tools[name] = resolveNodeToolRef(charter, toolRef.ref) as AnyToolDefinition<S>;
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
  charter: Charter<any>,
  nodeRef: Ref | SerialNode<S>,
): Node<any, S> {
  if (isRef(nodeRef)) {
    const node = charter.nodes[nodeRef.ref];
    if (!node) {
      throw new Error(`Unknown node ref: ${nodeRef.ref}`);
    }
    return node as Node<any, S>;
  }
  return deserializeNode(charter, nodeRef);
}
