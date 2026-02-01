import type { JSONSchema } from "./refs.js";
import type { Command, CommandDefinition } from "./commands.js";
import type { Node } from "./node.js";
import type { NodeState } from "./instance.js";

/**
 * Metadata about a command (JSON-serializable).
 * Used in wire format for client-side display.
 */
export interface CommandMeta {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

/**
 * Wire format pack (JSON-serializable).
 * Contains pack name, validator schema, and command metadata.
 * State is stored separately in instance.packStates.
 */
export interface DryClientPack {
  name: string;
  description: string;
  validator: JSONSchema;
  commands: Record<string, CommandMeta>;
}

/**
 * Hydrated pack with callable command functions.
 * State is stored separately in instance.packStates.
 */
export interface ClientPack {
  name: string;
  description: string;
  validator: JSONSchema;
  commands: Record<string, (input: unknown) => Command>;
}

/**
 * Derive typed command functions from Node's command definitions.
 * Maps each command to a function that takes typed input and returns a Command.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NodeCommands<N> = N extends { commands: infer C }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ? C extends Record<string, CommandDefinition<any, any, any>>
    ? {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [K in keyof C]: C[K] extends CommandDefinition<infer TInput, any, any>
          ? (input: TInput) => Command
          : never;
      }
    : Record<string, never>
  : Record<string, never>;

/**
 * Wire format node (JSON-serializable).
 * Contains instructions, validator schema, command metadata, and pack definitions.
 * Sent over the wire to clients.
 */
export interface DryClientNode<N extends Node<any, any> = Node<any, any>> {
  instructions: string;
  validator: JSONSchema;
  commands: Record<string, CommandMeta>;
  packs?: DryClientPack[];
}

/**
 * Hydrated node with fully typed callable commands.
 * Created on the client by hydrating a DryClientNode.
 */
export interface ClientNode<N extends Node<any, any> = Node<any, any>> {
  instructions: string;
  validator: JSONSchema;
  commands: NodeCommands<N>;
  packs?: ClientPack[];
}

/**
 * Wire format instance (JSON-serializable).
 * Contains id, state, packStates, and a DryClientNode (which includes pack definitions).
 * Sent over the wire to clients.
 */
export interface DryClientInstance<N extends Node<any, any> = Node<any, any>> {
  id: string;
  state: NodeState<N>;
  packStates?: Record<string, unknown>;
  node: DryClientNode<N>;
}

/**
 * Hydrated instance with fully typed commands.
 * Created on the client by hydrating a DryClientInstance.
 */
export interface ClientInstance<N extends Node<any, any> = Node<any, any>> {
  id: string;
  state: NodeState<N>;
  packStates?: Record<string, unknown>;
  node: ClientNode<N>;
}
