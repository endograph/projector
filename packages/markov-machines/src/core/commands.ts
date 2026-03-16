import type { Machine } from "../types/machine";
import type { Instance } from "../types/instance";
import type {
  CommandInfo,
  CommandExecutionResult,
  CommandContext,
  CommandDefinition,
  CommandResult,
} from "../types/commands";
import type { PackCommandContext } from "../types/pack";
import type { MachineMessage } from "../types/messages";
import { userMessage, instanceMessage, commandMessage } from "../types/messages";
import { getActiveInstance, findInstanceById } from "../types/instance";
import { executeCommand as executeCommandOnInstance } from "../runtime/command-executor";
import { isCedeResult, isTransitionToResult } from "../types/transitions";
import { isCommandValueResult } from "../types/commands";
import { updateState as applyStateUpdate } from "../runtime/state-manager";

function mergePatch(
  current: Record<string, unknown> | undefined,
  patch: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...(current ?? {}),
    ...(patch as Record<string, unknown>),
  };
}

/**
 * Get available commands on the current active instance.
 * Includes both node commands and pack commands.
 */
export function getAvailableCommands(machine: Machine): CommandInfo[] {
  const active = getActiveInstance(machine.instance);
  const nodeCommands = active.node.commands ?? {};

  // Collect node commands
  const result: CommandInfo[] = Object.entries(nodeCommands).map(([name, cmd]) => ({
    name,
    description: cmd.description,
    inputSchema: cmd.inputSchema,
  }));

  // Collect pack commands from all packs on the node
  const packs = active.packs ?? active.node.packs ?? [];
  for (const pack of packs) {
    const packCommands = pack.commands ?? {};
    for (const [name, cmd] of Object.entries(packCommands)) {
      result.push({
        name,
        description: cmd.description,
        inputSchema: cmd.inputSchema,
      });
    }
  }

  return result;
}

/**
 * Execute a command on an instance.
 * If instanceId is provided, targets that specific instance (can be suspended).
 * Otherwise, targets the current active instance.
 * Returns the updated machine and the command result.
 *
 * Commands are searched in order: node commands first, then pack commands.
 *
 * @typeParam AppMessage - The application message type for structured outputs.
 */
export async function runCommand<AppMessage = unknown>(
  machine: Machine<AppMessage>,
  commandName: string,
  input: unknown = {},
  options?: { instanceId?: string; clientId?: string },
): Promise<{
  machine: Machine<AppMessage>;
  result: CommandExecutionResult;
  messages?: MachineMessage<AppMessage>[];
}> {
  const instanceId = options?.instanceId;
  const clientId = options?.clientId;

  // Enqueue the command message for history tracking
  const command = { type: "command" as const, name: commandName, input, instanceId, clientId };
  machine.enqueue([commandMessage([command])]);
  machine.externalize?.syncRegistrations();

  // Find the target instance
  let target: Instance;
  if (instanceId) {
    const found = findInstanceById(machine.instance, instanceId);
    if (!found) {
      return {
        machine,
        result: { success: false, error: `Instance not found: ${instanceId}` },
      };
    }
    target = found;
  } else {
    target = getActiveInstance(machine.instance);
  }

  // Check if this is a node command
  const nodeCommand = target.node.commands?.[commandName];
  if (nodeCommand) {
    // Execute as node command
    const { result, instance: updatedInstance, transitionResult, messages: rawMessages } =
      await executeCommandOnInstance(
        target,
        commandName,
        input,
        target.id,
        machine.history as MachineMessage<unknown>[],
        machine.enqueue as (msgs: MachineMessage<unknown>[]) => void,
      );

    if (!result.success) {
      return { machine, result };
    }

    // Enqueue messages if any, and convert string to MachineMessage for return
    const targetInstanceId = target.id;
    let messages: MachineMessage<AppMessage>[] | undefined;
    if (rawMessages) {
      if (typeof rawMessages === "string") {
        messages = [userMessage<AppMessage>(rawMessages, { source: { instanceId: targetInstanceId } })];
      } else {
        messages = rawMessages as MachineMessage<AppMessage>[];
      }
      machine.enqueue(messages);
    }

    // Handle cede - need to remove the target instance from the tree
    if (transitionResult && isCedeResult(transitionResult)) {
      const updatedRoot = removeActiveInstance(machine.instance, target.id);
      if (!updatedRoot) {
        return {
          machine,
          result: { success: false, error: "Cannot cede from root instance" },
        };
      }
      machine.instance = updatedRoot;
      machine.externalize?.syncRegistrations();
      return {
        machine,
        result,
        messages,
      };
    }

    // All other cases: replace instance in tree
    // externalized state instances ahve their state preserved. This is probably
    // the wrong behavior, it would be better to not allow transitions to change state, 
    // and then model all state changes as messages
    const shouldPreserveExternalizedNodeState =
      !!target.node.externalize?.state &&
      (!transitionResult || !isTransitionToResult(transitionResult));
    const replacement = shouldPreserveExternalizedNodeState
      ? { ...updatedInstance, state: target.state }
      : updatedInstance;
    const updatedRoot = replaceInstance(machine.instance, target.id, replacement);
    machine.instance = updatedRoot;
    machine.externalize?.syncRegistrations();
    return {
      machine,
      result,
      messages,
    };
  }

  // Check if this is a pack command
  const packs = target.packs ?? target.node.packs ?? [];
  for (const pack of packs) {
    if (pack.commands?.[commandName]) {
      // Pass ROOT's packStates (pack states are only stored on root instance)
      const packResult = await executePackCommand<AppMessage>(
        target,
        pack.name,
        commandName,
        input,
        machine.instance.packStates ?? {},
        machine.enqueue,
      );

      if (!packResult.success) {
        return { machine, result: packResult };
      }

      // Enqueue messages if any
      let messages: MachineMessage<AppMessage>[] | undefined;
      if (packResult.messages) {
        // Pack commands always return MachineMessage[] (never string)
        messages = packResult.messages;
        machine.enqueue(messages);
      }

      // State updates are now handled via instanceMessage queue
      // They will be applied when the queue is drained in runMachine
      return {
        machine,
        result: packResult,
        messages,
      };
    }
  }

  // Command not found
  return {
    machine,
    result: { success: false, error: `Command not found: ${commandName}` },
  };
}

/**
 * Execute a pack command.
 * @param instance - The target instance (used to find the pack on the node)
 * @param packName - The pack name
 * @param commandName - The command name
 * @param input - The command input
 * @param rootPackStates - Pack states from the ROOT instance (pack states are only stored on root)
 * @param enqueue - Function to enqueue messages (for state updates via instanceMessage)
 */
async function executePackCommand<AppMessage = unknown>(
  instance: Instance,
  packName: string,
  commandName: string,
  input: unknown,
  rootPackStates: Record<string, unknown>,
  enqueue: (msgs: MachineMessage<AppMessage>[]) => void,
): Promise<CommandExecutionResult & {
  messages?: MachineMessage<AppMessage>[];
}> {
  // Find the pack on the instance (deserialized) or fall back to node
  const pack = (instance.packs ?? instance.node.packs)?.find((p) => p.name === packName);
  if (!pack) {
    return { success: false, error: `Pack not found: ${packName}` };
  }

  // Find the command in the pack
  const command = pack.commands?.[commandName];
  if (!command) {
    return { success: false, error: `Command not found: ${packName}:${commandName}` };
  }

  // Validate input
  const parsed = command.inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `Invalid input: ${parsed.error.message}` };
  }

  // Get current pack state from ROOT (not from instance - pack states are only on root)
  let packState = rootPackStates[packName] ?? pack.initialState ?? {};
  let hasPackStateUpdate = false;
  let accumulatedPatch: Record<string, unknown> | undefined;

  // Create context
  const ctx: PackCommandContext<unknown> = {
    state: packState,
    updateState: (patch: Partial<unknown>) => {
      const result = applyStateUpdate(
        packState as Record<string, unknown>,
        patch as Partial<Record<string, unknown>>,
        pack.validator as any,
      );
      if (!result.success) {
        throw new Error(`Pack state update validation failed: ${result.error}`);
      }
      packState = result.state;
      hasPackStateUpdate = true;
      accumulatedPatch = mergePatch(
        accumulatedPatch,
        patch as Partial<Record<string, unknown>>,
      );
    },
  };

  try {
    const cmdResult = await command.execute(parsed.data, ctx);

    // Handle command result (with optional messages to enqueue)
    if (cmdResult && isCommandValueResult(cmdResult)) {
      return {
        success: true,
        value: cmdResult.payload,
        messages: cmdResult.messages as MachineMessage<AppMessage>[] | undefined,
      };
    }

    // Handle void/undefined result (silent update)
    return {
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  } finally {
    if (hasPackStateUpdate) {
      enqueue([instanceMessage<AppMessage>(
        {
          kind: "packState",
          packName,
          patch: accumulatedPatch ?? (packState as Record<string, unknown>),
        },
      )]);
    }
  }
}

/**
 * Replace an instance in the tree by ID.
 */
function replaceInstance(
  root: Instance,
  targetId: string,
  replacement: Instance,
): Instance {
  if (root.id === targetId) {
    return replacement;
  }

  const children = root.children;
  if (!children || children.length === 0) {
    return root;
  }

  return {
    ...root,
    children: children.map((child) =>
      replaceInstance(child, targetId, replacement),
    ),
  };
}

/**
 * Remove an instance from the tree by ID.
 * Returns undefined if the root itself is removed.
 */
function removeActiveInstance(
  root: Instance,
  targetId: string,
): Instance | undefined {
  if (root.id === targetId) {
    return undefined;
  }

  const children = root.children;
  if (!children || children.length === 0) {
    return root;
  }

  const filtered = children
    .map((child) => removeActiveInstance(child, targetId))
    .filter((c): c is Instance => c !== undefined);

  return {
    ...root,
    children: filtered.length === 0 ? undefined : filtered,
  };
}

/**
 * Configuration for creating a command.
 * Alias for CommandDefinition.
 */
export type CommandConfig<TInput, TOutput, S> = CommandDefinition<TInput, TOutput, S>;

/**
 * Create a command definition.
 * Helper function for type inference.
 */
export function createCommand<TInput, TOutput, S>(
  config: CommandConfig<TInput, TOutput, S>,
): CommandDefinition<TInput, TOutput, S> {
  return config;
}
