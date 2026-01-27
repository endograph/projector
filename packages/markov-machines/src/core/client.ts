import { z } from "zod";
import type { Node } from "../types/node.js";
import type { Instance, NodeState } from "../types/instance.js";
import type {
  DryClientNode,
  DryClientInstance,
  DryClientPack,
  ClientNode,
  ClientInstance,
  ClientPack,
  CommandMeta,
  NodeCommands,
} from "../types/client.js";
import type { Command, AnyCommandDefinition } from "../types/commands.js";
import type { JSONSchema } from "../types/refs.js";
import type { Pack } from "../types/pack.js";
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
 * Create a DryClientPack from a Pack and its current state.
 */
export function createDryClientPack(
  pack: Pack,
  state: unknown,
): DryClientPack {
  // Convert validator to JSON Schema
  const validator = z.toJSONSchema(pack.validator, {
    target: ZOD_JSON_SCHEMA_TARGET_DRAFT_2020_12,
  }) as JSONSchema;

  // Extract command metadata from pack commands
  const commands: Record<string, CommandMeta> = {};
  const packCommands = pack.commands ?? {};
  for (const [name, cmd] of Object.entries(packCommands)) {
    commands[name] = {
      name: cmd.name,
      description: cmd.description,
      inputSchema: z.toJSONSchema(cmd.inputSchema, {
        target: ZOD_JSON_SCHEMA_TARGET_DRAFT_2020_12,
      }) as JSONSchema,
    };
  }

  return {
    name: pack.name,
    description: pack.description,
    state,
    validator,
    commands,
  };
}

/**
 * Create a DryClientInstance from a full Instance.
 * Extracts id, state, packs (with state/validator/commands), and converts node to DryClientNode.
 */
export function createDryClientInstance<N extends Node<any, any>>(
  instance: Instance<N>,
): DryClientInstance<N> {
  // Build packs array from node.packs and instance.packStates
  const nodePacks = instance.node.packs ?? [];
  const packStates = instance.packStates ?? {};

  let packs: DryClientPack[] | undefined;
  if (nodePacks.length > 0) {
    packs = nodePacks.map((pack) => {
      const state = packStates[pack.name] ?? pack.initialState ?? {};
      return createDryClientPack(pack, state);
    });
  }

  return {
    id: instance.id,
    state: instance.state as NodeState<N>,
    ...(packs ? { packs } : {}),
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
 * Hydrate a DryClientPack into a ClientPack.
 * Converts command metadata into callable functions.
 */
export function hydrateClientPack(dry: DryClientPack): ClientPack {
  const commands: Record<string, (input: unknown) => Command> = {};
  for (const [name, meta] of Object.entries(dry.commands)) {
    commands[name] = (input: unknown): Command => ({
      type: "command",
      name: meta.name,
      input,
    });
  }

  return {
    name: dry.name,
    description: dry.description,
    state: dry.state,
    validator: dry.validator,
    commands,
  };
}

/**
 * Hydrate a DryClientInstance into a ClientInstance.
 * Converts command metadata into callable functions with full type safety.
 */
export function hydrateClientInstance<N extends Node<any, any>>(
  dry: DryClientInstance<N>,
): ClientInstance<N> {
  // Hydrate packs if present
  let packs: ClientPack[] | undefined;
  if (dry.packs && dry.packs.length > 0) {
    packs = dry.packs.map(hydrateClientPack);
  }

  return {
    id: dry.id,
    state: dry.state,
    ...(packs ? { packs } : {}),
    node: hydrateClientNode(dry.node),
  };
}
