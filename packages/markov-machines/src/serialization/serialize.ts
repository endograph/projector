import { z } from "zod";
import type { Node } from "../types/node";
import type { Instance } from "../types/instance";
import type {
  Machine,
  SerializedMachine,
  SerializedInstance,
  SerialPackInstance,
} from "../types/machine";
import type { Ref, SerialNode, SerialTransition, SerialPack } from "../types/refs";
import type { Charter } from "../types/charter";
import type { Transition } from "../types/transitions";
import type { Pack } from "../types/pack";
import { isRef, isSerialTransition } from "../types/refs";
import { isCodeTransition, isGeneralTransition } from "../types/transitions";
import { toSafeJsonSchema } from "../helpers/json-schema";

export interface SerializeNodeOptions {
  /** If true, always inline this node even if registered in charter. Tool/transition refs are unaffected. */
  noNodeRef?: boolean;
}

/**
 * Check if a value is a Zod schema (has safeParse method) vs already-serialized JSONSchema.
 */
function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as z.ZodType).safeParse === "function"
  );
}

/**
 * Serialize a node to a SerialNode or Ref.
 * If the node is registered in the charter, returns a Ref (unless noNodeRef is true).
 * Otherwise, serializes the full node with tool/transition refs.
 */
export function serializeNode<S>(
  node: Node<any, S>,
  charter?: Charter<any>,
  options?: SerializeNodeOptions,
): SerialNode<S> | Ref {
  // Check if this node is registered in the charter (unless noNodeRef is set)
  if (charter && !options?.noNodeRef) {
    for (const [name, registeredNode] of Object.entries(charter.nodes)) {
      if (registeredNode.id === node.id) {
        return { ref: name };
      }
    }
  }

  // Serialize the validator to JSON Schema (pass through if already JSONSchema)
  const validator: Record<string, unknown> = isZodSchema(node.validator)
    ? toSafeJsonSchema(node.validator)
    : (node.validator as Record<string, unknown>);

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

  // Serialize tool refs (node tools only — not packs)
  const toolRefs: Record<string, Ref> = {};
  if (charter) {
    for (const [name, tool] of Object.entries(node.tools)) {
      // 1. Check charter.tools (flat ref)
      let found = false;
      for (const [regName, regTool] of Object.entries(charter.tools)) {
        if (regTool === tool) {
          toolRefs[name] = { ref: regName };
          found = true;
          break;
        }
      }
      if (found) continue;
      // 2. Check charter.nodes (nested ref)
      for (const [nodeName, regNode] of Object.entries(charter.nodes)) {
        if (regNode.tools[name] === tool) {
          toolRefs[name] = { ref: `${nodeName}.${name}` };
          found = true;
          break;
        }
      }
      // Unregistered inline tools are skipped (can't be serialized)
    }
  }

  return {
    instructions: node.instructions,
    validator,
    transitions,
    ...(Object.keys(toolRefs).length > 0 ? { tools: toolRefs } : {}),
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
    if (charter) {
      // 1. Check charter.transitions (flat ref)
      for (const [name, registeredTransition] of Object.entries(
        charter.transitions,
      )) {
        if (registeredTransition === transition) {
          return { ref: name };
        }
      }
      // 2. Check charter.nodes (nested ref)
      for (const [nodeName, regNode] of Object.entries(charter.nodes)) {
        for (const [transName, regTransition] of Object.entries(regNode.transitions)) {
          if (regTransition === transition) {
            return { ref: `${nodeName}.${transName}` };
          }
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

/**
 * Serialize a pack to a Ref or inline SerialPack.
 * If the pack's instructions match the charter pack's instructions, returns a Ref.
 * Otherwise, serializes the full pack definition with the pack's current instructions.
 */
export function serializePack(
  pack: Pack,
  state: unknown,
  charter?: Charter,
): Ref | SerialPack {
  // Check if this pack's instructions match the charter pack's instructions
  if (charter?.packs) {
    const charterPack = charter.packs.find((p) => p.name === pack.name);
    if (charterPack) {
      // Compare instructions - if they match, use ref
      const charterInstructions = typeof charterPack.instructions === "function"
        ? charterPack.instructions(state)
        : charterPack.instructions;
      const packInstructions = typeof pack.instructions === "function"
        ? pack.instructions(state)
        : pack.instructions;

      if (charterInstructions === packInstructions) {
        return { ref: pack.name };
      }
    }
  }

  // Serialize the validator to JSON Schema
  const validator: Record<string, unknown> = isZodSchema(pack.validator)
    ? toSafeJsonSchema(pack.validator)
    : (pack.validator as Record<string, unknown>);

  // Resolve instructions from pack
  let instructions: string | undefined;
  if (typeof pack.instructions === "function") {
    try {
      instructions = pack.instructions(state);
    } catch {
      instructions = "(error resolving dynamic instructions)";
    }
  } else {
    instructions = pack.instructions;
  }

  // Serialize tool refs (pack tools must be registered in charter to serialize)
  const toolRefs: Record<string, Ref> = {};
  if (charter?.packs) {
    const charterPack = charter.packs.find((p) => p.name === pack.name);
    if (charterPack) {
      for (const [name, tool] of Object.entries(pack.tools)) {
        if (charterPack.tools[name] === tool) {
          toolRefs[name] = { ref: `${pack.name}.${name}` };
        }
      }
    }
  }

  // Serialize command refs (pack commands must be registered in charter to serialize)
  const commandRefs: Record<string, Ref> = {};
  if (charter?.packs && pack.commands) {
    const charterPack = charter.packs.find((p) => p.name === pack.name);
    if (charterPack?.commands) {
      for (const [name, command] of Object.entries(pack.commands)) {
        if (charterPack.commands[name] === command) {
          commandRefs[name] = { ref: `${pack.name}.${name}` };
        }
      }
    }
  }

  return {
    name: pack.name,
    description: pack.description,
    ...(instructions !== undefined ? { instructions } : {}),
    validator,
    ...(Object.keys(toolRefs).length > 0 ? { tools: toolRefs } : {}),
    ...(Object.keys(commandRefs).length > 0 ? { commands: commandRefs } : {}),
    ...(pack.initialState !== undefined ? { initialState: pack.initialState } : {}),
  };
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

  // Serialize pack instances (only on root - when packStates exists)
  // Use instance.packs (deserialized with correct instructions) or fall back to node.packs
  let packInstances: SerialPackInstance[] | undefined;
  const packsToSerialize = instance.packs ?? instance.node.packs ?? [];
  if (instance.packStates && packsToSerialize.length > 0) {
    packInstances = packsToSerialize.map((pack) => {
      const state = instance.packStates![pack.name] ?? pack.initialState ?? {};
      return {
        state,
        pack: serializePack(pack, state, charter),
      };
    });
  }

  return {
    id: instance.id,
    node: serializedNode,
    state: instance.state,
    children,
    ...(packInstances && packInstances.length > 0 ? { packInstances } : {}),
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
