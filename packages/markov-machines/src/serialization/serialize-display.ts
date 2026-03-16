import type { Charter } from "../types/charter";
import type { Instance } from "../types/instance";
import type {
  DisplayCommand,
  DisplayInstance,
  DisplayNode,
  DisplayPack,
} from "../types/display";
import { toSafeJsonSchema } from "../helpers/json-schema";

/**
 * Custom serialization for display purposes.
 * Unlike the standard serializer, this always expands nodes fully
 * (showing instructions, validator, etc.) instead of converting to refs.
 * Tools and transitions are shown as refs/names only.
 *
 * JSON Schema `$`-prefixed keys are automatically escaped to `__`-prefixed.
 */

function getTransitionTarget(transition: unknown, charter?: Charter): string {
  if (!transition) return "unknown";

  if (typeof transition === "object" && transition !== null && "ref" in transition) {
    return (transition as { ref: string }).ref;
  }

  if (typeof transition === "object" && transition !== null && "id" in transition) {
    const nodeId = (transition as { id: string }).id;
    if (charter) {
      for (const [name, node] of Object.entries(charter.nodes)) {
        if (node.id === nodeId) {
          return name;
        }
      }
    }
    return "inline";
  }

  if (typeof transition === "object" && transition !== null && "node" in transition) {
    return getTransitionTarget((transition as { node: unknown }).node, charter);
  }

  if (charter) {
    for (const [name, t] of Object.entries(charter.transitions)) {
      if (t === transition) {
        return name;
      }
    }
  }

  return "code";
}

function getNodeName(node: Instance["node"], charter?: Charter): string {
  if (charter) {
    for (const [name, registeredNode] of Object.entries(charter.nodes)) {
      if (registeredNode.id === node.id) {
        return name;
      }
    }
  }
  // Preserve name from inlined nodes (set when a ref-backed node is edited)
  if ("name" in node && typeof (node as any).name === "string") {
    return `[inline] ${(node as any).name}`;
  }
  return "[inline]";
}

function serializeCommandsForDisplay(
  commands: Record<string, { name: string; description: string; inputSchema: { _def?: unknown } }> | undefined,
): Record<string, DisplayCommand> {
  const result: Record<string, DisplayCommand> = {};
  if (!commands) return result;

  for (const [cmdName, cmd] of Object.entries(commands)) {
    let inputSchema: Record<string, unknown> = {};
    try {
      inputSchema = toSafeJsonSchema(cmd.inputSchema as any);
    } catch {
      inputSchema = { error: "Could not serialize schema" };
    }
    result[cmdName] = {
      name: cmd.name,
      description: cmd.description,
      inputSchema,
    };
  }
  return result;
}

export function serializeNodeForDisplay(node: Instance["node"], charter?: Charter): DisplayNode {
  const name = getNodeName(node, charter);

  let validator: Record<string, unknown> = {};
  try {
    validator = toSafeJsonSchema(node.validator);
  } catch {
    validator = { error: "Could not serialize validator" };
  }

  const tools = Object.keys(node.tools || {});

  const transitions: Record<string, string> = {};
  for (const [transitionName, transition] of Object.entries(node.transitions || {})) {
    transitions[transitionName] = getTransitionTarget(transition, charter);
  }

  const packNames = node.packs?.map((p) => p.name);
  const commands = serializeCommandsForDisplay(node.commands as any);

  return {
    name,
    instructions: node.instructions,
    validator,
    tools,
    transitions,
    commands,
    ...(node.initialState !== undefined ? { initialState: node.initialState } : {}),
    ...(packNames && packNames.length > 0 ? { packNames } : {}),
    ...(node.worker ? { worker: true } : {}),
    ...(node.executorConfig ? { executorConfig: node.executorConfig } : {}),
  };
}

export function serializePackForDisplay(
  pack: {
    name: string;
    description: string;
    instructions?: string | ((state: unknown) => string);
    validator: { _def?: unknown };
    commands?: Record<string, { name: string; description: string; inputSchema: { _def?: unknown } }>;
  },
  state: unknown,
): DisplayPack {
  let validator: Record<string, unknown> = {};
  try {
    validator = toSafeJsonSchema(pack.validator as any);
  } catch {
    validator = { error: "Could not serialize validator" };
  }

  const commands = serializeCommandsForDisplay(pack.commands as any);

  // Resolve instructions (may be static string or function of state)
  // The pack already has the correct instructions (from charter or edited by user)
  let instructions: string | undefined;
  let instructionsDynamic = false;

  if (typeof pack.instructions === "function") {
    instructionsDynamic = true;
    try {
      instructions = pack.instructions(state);
    } catch {
      instructions = "(error resolving dynamic instructions)";
    }
  } else {
    instructions = pack.instructions;
  }

  return {
    name: pack.name,
    description: pack.description,
    ...(instructions !== undefined ? { instructions } : {}),
    ...(instructionsDynamic ? { instructionsDynamic } : {}),
    state,
    validator,
    commands,
  };
}

export function serializeInstanceForDisplay(
  instance: Instance,
  charter?: Charter,
): DisplayInstance {
  const node = serializeNodeForDisplay(instance.node, charter);

  let children: DisplayInstance[] | undefined;
  if (instance.children && instance.children.length > 0) {
    children = instance.children.map((c) => serializeInstanceForDisplay(c, charter));
  }

  // Build packs array with full info including current state
  // Use instance.packs (deserialized with correct instructions) or fall back to node.packs
  let packs: DisplayPack[] | undefined;
  const instancePacks = instance.packs ?? instance.node.packs ?? [];
  const packStates = instance.packStates ?? {};
  // Only serialize full packs at root instance (where packStates is stored)
  if (instancePacks.length > 0 && instance.packStates) {
    packs = instancePacks.map((pack) => {
      const state = packStates[pack.name] ?? pack.initialState ?? {};
      return serializePackForDisplay(pack as any, state);
    });
  }

  return {
    id: instance.id,
    node,
    state: instance.state,
    ...(children ? { children } : {}),
    ...(packs ? { packs } : {}),
    ...(instance.packStates ? { packStates: instance.packStates } : {}),
    ...(instance.suspended
      ? {
          suspended: {
            suspendId: instance.suspended.suspendId,
            reason: instance.suspended.reason,
            suspendedAt: instance.suspended.suspendedAt.toISOString(),
            metadata: instance.suspended.metadata,
          },
        }
      : {}),
  };
}
