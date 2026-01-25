import { z } from "zod";
import type { Node } from "../types/node.js";
import type { Instance } from "../types/instance.js";
import type {
  Machine,
  SerializedMachine,
  SerializedInstance,
} from "../types/machine.js";
import type { Ref, SerialNode, SerialTransition } from "../types/refs.js";
import type { Charter } from "../types/charter.js";
import type { Transition } from "../types/transitions.js";
import { isRef, isSerialTransition } from "../types/refs.js";
import { isCodeTransition, isGeneralTransition } from "../types/transitions.js";
import { ZOD_JSON_SCHEMA_TARGET_DRAFT_2020_12 } from "../helpers/json-schema.js";

export interface SerializeNodeOptions {
  /** If true, always serialize the full node even if it's registered in the charter */
  noRefs?: boolean;
}

/**
 * Serialize a node to a SerialNode or Ref.
 * If the node is registered in the charter, returns a Ref (unless noRefs is true).
 * Otherwise, serializes the full node.
 */
export function serializeNode<S>(
  node: Node<any, S>,
  charter?: Charter<any>,
  options?: SerializeNodeOptions,
): SerialNode<S> | Ref {
  // Check if this node is registered in the charter (unless noRefs is set)
  if (charter && !options?.noRefs) {
    for (const [name, registeredNode] of Object.entries(charter.nodes)) {
      if (registeredNode.id === node.id) {
        return { ref: name };
      }
    }
  }

  // Serialize the validator to JSON Schema
  const validator: Record<string, unknown> = z.toJSONSchema(node.validator, {
    target: ZOD_JSON_SCHEMA_TARGET_DRAFT_2020_12,
  }) as Record<string, unknown>;

  // Serialize transitions
  const transitions: Record<string, Ref | SerialTransition> = {};
  for (const [name, transition] of Object.entries(node.transitions)) {
    const serialized = serializeTransition(transition, charter);
    // Convert SerialNode to a SerialTransition wrapper if needed
    if (!isRef(serialized)) {
      transitions[name] = {
        type: "serial",
        description: "Transition",
        node: serialized,
      };
    } else {
      transitions[name] = serialized;
    }
  }

  return {
    instructions: node.instructions,
    validator,
    transitions,
    initialState: node.initialState,
  };
}

/**
 * Serialize a transition to a Ref or inline definition.
 */
function serializeTransition<S>(
  transition: Transition<S>,
  charter?: Charter,
): Ref | SerialNode {
  // If it's already a ref, keep it
  if (isRef(transition)) {
    return transition;
  }

  // Code transitions and general transitions can't be fully serialized
  // They must be registered in the charter
  if (isCodeTransition(transition) || isGeneralTransition(transition)) {
    // Check if registered
    if (charter) {
      for (const [name, registeredTransition] of Object.entries(
        charter.transitions,
      )) {
        if (registeredTransition === transition) {
          return { ref: name };
        }
      }
    }
    throw new Error(
      "CodeTransition and GeneralTransition must be registered in the charter for serialization",
    );
  }

  // SerialTransition - already serializable
  if (isSerialTransition(transition)) {
    if (isRef(transition.node)) {
      return transition.node;
    }
    return transition.node as SerialNode;
  }

  throw new Error("Unknown transition type");
}

export interface SerializeInstanceOptions extends SerializeNodeOptions {}

/**
 * Serialize a node instance to a SerializedInstance.
 */
export function serializeInstance(
  instance: Instance,
  charter?: Charter<any>,
  options?: SerializeInstanceOptions,
): SerializedInstance {
  const serializedNode = serializeNode(instance.node, charter, options);

  // Serialize children
  let children: SerializedInstance[] | undefined;
  if (instance.children && instance.children.length > 0) {
    children = instance.children.map((c) => serializeInstance(c, charter, options));
  }

  return {
    id: instance.id,
    node: serializedNode,
    state: instance.state,
    children,
    ...(instance.packStates ? { packStates: instance.packStates } : {}),
    ...(instance.executorConfig ? { executorConfig: instance.executorConfig } : {}),
    ...(instance.suspended ? {
      suspended: {
        suspendId: instance.suspended.suspendId,
        reason: instance.suspended.reason,
        suspendedAt: instance.suspended.suspendedAt.toISOString(),
        metadata: instance.suspended.metadata,
      }
    } : {}),
  };
}

/**
 * Serialize a machine for persistence.
 */
export function serializeMachine<AppMessage = unknown>(
  machine: Machine<AppMessage>,
): SerializedMachine<AppMessage> {
  return {
    instance: serializeInstance(machine.instance, machine.charter),
    history: machine.history,
  };
}
