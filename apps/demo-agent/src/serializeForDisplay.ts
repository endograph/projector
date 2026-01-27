import { z } from "zod";
import type { Instance } from "markov-machines";
import type { Charter } from "markov-machines";

/**
 * Custom serialization for display purposes.
 * Unlike the standard serializer, this always expands nodes fully
 * (showing instructions, validator, etc.) instead of converting to refs.
 * Tools and transitions are shown as refs/names only.
 */

interface DisplayCommand {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface DisplayPack {
  name: string;
  description: string;
  state: unknown;
  validator: Record<string, unknown>;
  commands: Record<string, DisplayCommand>;
}

interface DisplayNode {
  name: string; // Node name from charter, or "[inline]"
  instructions: string;
  validator: Record<string, unknown>;
  tools: string[]; // Just tool names
  transitions: Record<string, string>; // name -> target ref or "inline"
  commands: Record<string, DisplayCommand>; // Command metadata
  initialState?: unknown;
  packNames?: string[]; // Pack names (for reference)
  worker?: boolean;
}

interface DisplayInstance {
  id: string;
  node: DisplayNode;
  state: unknown;
  children?: DisplayInstance[];
  packs?: DisplayPack[]; // Full pack info with state, validator, and commands
  executorConfig?: Record<string, unknown>;
  suspended?: {
    suspendId: string;
    reason: string;
    suspendedAt: string;
    metadata?: Record<string, unknown>;
  };
}

/**
 * Sanitize an object for Convex storage by replacing $ prefixed keys.
 * Convex doesn't allow field names starting with $.
 */
function sanitizeForConvex(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map(sanitizeForConvex);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    // Replace $ prefix with _ to make it Convex-safe
    const safeKey = key.startsWith("$") ? `_${key.slice(1)}` : key;
    result[safeKey] = sanitizeForConvex(value);
  }
  return result;
}

function getTransitionTarget(transition: unknown, charter?: Charter): string {
  if (!transition) return "unknown";

  // Check if it's a ref
  if (typeof transition === "object" && transition !== null && "ref" in transition) {
    return (transition as { ref: string }).ref;
  }

  // Check if it's a node (has id)
  if (typeof transition === "object" && transition !== null && "id" in transition) {
    const nodeId = (transition as { id: string }).id;
    // Try to find in charter
    if (charter) {
      for (const [name, node] of Object.entries(charter.nodes)) {
        if (node.id === nodeId) {
          return name;
        }
      }
    }
    return "inline";
  }

  // Check if it's a transition object with a node property
  if (typeof transition === "object" && transition !== null && "node" in transition) {
    return getTransitionTarget((transition as { node: unknown }).node, charter);
  }

  // Check charter transitions
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
  return "[inline]";
}

function serializeNodeForDisplay(node: Instance["node"], charter?: Charter): DisplayNode {
  // Look up node name from charter
  const name = getNodeName(node, charter);

  // Convert validator to JSON schema and sanitize for Convex
  let validator: Record<string, unknown> = {};
  try {
    const rawValidator = z.toJSONSchema(node.validator, {
      target: "draft-2020-12",
    }) as Record<string, unknown>;
    validator = sanitizeForConvex(rawValidator) as Record<string, unknown>;
  } catch {
    validator = { error: "Could not serialize validator" };
  }

  // Get tool names
  const tools = Object.keys(node.tools || {});

  // Get transition targets
  const transitions: Record<string, string> = {};
  for (const [transitionName, transition] of Object.entries(node.transitions || {})) {
    transitions[transitionName] = getTransitionTarget(transition, charter);
  }

  // Get pack names
  const packNames = node.packs?.map((p) => p.name);

  // Serialize commands (name, description, inputSchema)
  const commands: Record<string, DisplayCommand> = {};
  if (node.commands) {
    for (const [cmdName, cmd] of Object.entries(node.commands)) {
      let inputSchema: Record<string, unknown> = {};
      try {
        const rawSchema = z.toJSONSchema(cmd.inputSchema, {
          target: "draft-2020-12",
        }) as Record<string, unknown>;
        inputSchema = sanitizeForConvex(rawSchema) as Record<string, unknown>;
      } catch {
        inputSchema = { error: "Could not serialize schema" };
      }
      commands[cmdName] = {
        name: cmd.name,
        description: cmd.description,
        inputSchema,
      };
    }
  }

  return {
    name,
    instructions: node.instructions,
    validator,
    tools,
    transitions,
    commands,
    ...(node.initialState !== undefined ? { initialState: sanitizeForConvex(node.initialState) } : {}),
    ...(packNames && packNames.length > 0 ? { packNames } : {}),
    ...(node.worker ? { worker: true } : {}),
  };
}

function serializePackForDisplay(
  pack: { name: string; description: string; validator: z.ZodType<unknown>; commands?: Record<string, { name: string; description: string; inputSchema: z.ZodType<unknown> }> },
  state: unknown
): DisplayPack {
  // Convert validator to JSON schema
  let validator: Record<string, unknown> = {};
  try {
    const rawValidator = z.toJSONSchema(pack.validator, {
      target: "draft-2020-12",
    }) as Record<string, unknown>;
    validator = sanitizeForConvex(rawValidator) as Record<string, unknown>;
  } catch {
    validator = { error: "Could not serialize validator" };
  }

  // Serialize pack commands
  const commands: Record<string, DisplayCommand> = {};
  if (pack.commands) {
    for (const [cmdName, cmd] of Object.entries(pack.commands)) {
      let inputSchema: Record<string, unknown> = {};
      try {
        const rawSchema = z.toJSONSchema(cmd.inputSchema, {
          target: "draft-2020-12",
        }) as Record<string, unknown>;
        inputSchema = sanitizeForConvex(rawSchema) as Record<string, unknown>;
      } catch {
        inputSchema = { error: "Could not serialize schema" };
      }
      commands[cmdName] = {
        name: cmd.name,
        description: cmd.description,
        inputSchema,
      };
    }
  }

  return {
    name: pack.name,
    description: pack.description,
    state,
    validator,
    commands,
  };
}

export function serializeInstanceForDisplay(
  instance: Instance,
  charter?: Charter
): DisplayInstance {
  const node = serializeNodeForDisplay(instance.node, charter);

  let children: DisplayInstance[] | undefined;
  if (instance.children && instance.children.length > 0) {
    children = instance.children.map((c) => serializeInstanceForDisplay(c, charter));
  }

  // Build packs array with full info
  let packs: DisplayPack[] | undefined;
  const nodePacks = instance.node.packs ?? [];
  const packStates = instance.packStates ?? {};
  if (nodePacks.length > 0) {
    packs = nodePacks.map((pack) => {
      const state = packStates[pack.name] ?? pack.initialState ?? {};
      return serializePackForDisplay(pack as any, state);
    });
  }

  const result = {
    id: instance.id,
    node,
    state: instance.state,
    ...(children ? { children } : {}),
    ...(packs ? { packs } : {}),
    ...(instance.executorConfig ? { executorConfig: { ...instance.executorConfig } } : {}),
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

  // Sanitize the entire result to ensure no $ prefixed keys anywhere
  return sanitizeForConvex(result) as DisplayInstance;
}
