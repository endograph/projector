import { z } from "zod";
import type { Node } from "../types/node.js";
import type { Instance, NodeState } from "../types/instance.js";
import type {
  DryClientNode,
  DryClientInstance,
  ClientNode,
  ClientInstance,
  CommandMeta,
  NodeCommands,
} from "../types/client.js";
import type { Command, AnyCommandDefinition } from "../types/commands.js";
import type { JSONSchema } from "../types/refs.js";
import { ZOD_JSON_SCHEMA_TARGET_DRAFT_2020_12 } from "../helpers/json-schema.js";

/**
 * Create a DryClientNode from a Node.
 * Extracts instructions, validator (as JSON Schema), and command metadata.
 */
export function createDryClientNode<N extends Node<any, any>>(
  node: N,
): DryClientNode<N> {
  // Convert validator to JSON Schema
  const validator = z.toJSONSchema(node.validator, {
    target: ZOD_JSON_SCHEMA_TARGET_DRAFT_2020_12,
  }) as JSONSchema;

  // Extract command metadata
  const commands: Record<string, CommandMeta> = {};
  if (node.commands) {
    for (const [name, cmd] of Object.entries(node.commands)) {
      const command = cmd as AnyCommandDefinition;
      commands[name] = {
        name: command.name,
        description: command.description,
        inputSchema: z.toJSONSchema(command.inputSchema, {
          target: ZOD_JSON_SCHEMA_TARGET_DRAFT_2020_12,
        }) as JSONSchema,
      };
    }
  }

  return {
    instructions: node.instructions,
    validator,
    commands,
  };
}

/**
 * Create a DryClientInstance from a full Instance.
 * Extracts id, state, packStates, and converts node to DryClientNode.
 */
export function createDryClientInstance<N extends Node<any, any>>(
  instance: Instance<N>,
): DryClientInstance<N> {
  return {
    id: instance.id,
    state: instance.state as NodeState<N>,
    ...(instance.packStates ? { packStates: instance.packStates } : {}),
    node: createDryClientNode(instance.node),
  };
}

/**
 * Hydrate a DryClientNode into a ClientNode.
 * Converts command metadata into callable functions that return Command objects.
 */
export function hydrateClientNode<N extends Node<any, any>>(
  dry: DryClientNode<N>,
): ClientNode<N> {
  // Create callable command functions from metadata
  const commands: Record<string, (input: unknown) => Command> = {};
  for (const [name, meta] of Object.entries(dry.commands)) {
    commands[name] = (input: unknown): Command => ({
      type: "command",
      name: meta.name,
      input,
    });
  }

  return {
    instructions: dry.instructions,
    validator: dry.validator,
    commands: commands as NodeCommands<N>,
  };
}

/**
 * Hydrate a DryClientInstance into a ClientInstance.
 * Converts command metadata into callable functions with full type safety.
 */
export function hydrateClientInstance<N extends Node<any, any>>(
  dry: DryClientInstance<N>,
): ClientInstance<N> {
  return {
    id: dry.id,
    state: dry.state,
    ...(dry.packStates ? { packStates: dry.packStates } : {}),
    node: hydrateClientNode(dry.node),
  };
}
