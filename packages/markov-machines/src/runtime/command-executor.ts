import type { Instance, SuspendInfo } from "../types/instance.js";
import type { Node } from "../types/node.js";
import type { Message } from "../types/messages.js";
import type {
  CommandContext,
  CommandResult,
  CommandExecutionResult,
} from "../types/commands.js";
import { isValueResult, isResumeResult } from "../types/commands.js";
import type { SpawnTarget, SpawnOptions } from "../types/transitions.js";
import {
  isTransitionToResult,
  isSpawnResult,
  isCedeResult,
  isSuspendResult,
} from "../types/transitions.js";
import { isToolReply } from "../types/tools.js";
import { cede, spawn, suspend } from "../helpers/cede-spawn.js";
import { shallowMerge } from "../types/state.js";
import { createInstance, createSuspendInfo, clearSuspension } from "../types/instance.js";

/**
 * Execute a command on an instance.
 * Returns the result and the updated instance.
 */
export async function executeCommand(
  instance: Instance,
  commandName: string,
  input: unknown,
  instanceId: string,
  history: Message<unknown>[],
): Promise<{
  result: CommandExecutionResult;
  instance: Instance;
  transitionResult?: CommandResult;
  suspendInfo?: SuspendInfo;
  replyMessages?: { userMessage: unknown; llmMessage: string };
}> {
  const command = instance.node.commands?.[commandName];
  if (!command) {
    return {
      result: { success: false, error: `Command not found: ${commandName}` },
      instance,
    };
  }

  // Validate input
  const parsed = command.inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      result: { success: false, error: `Invalid input: ${parsed.error.message}` },
      instance,
    };
  }

  // Track state updates
  let currentState = instance.state;
  const updateState = (patch: Partial<unknown>) => {
    currentState = shallowMerge(
      currentState as Record<string, unknown>,
      patch as Record<string, unknown>,
    );
  };

  // Create getInstanceMessages function that filters by sourceInstanceId
  const getInstanceMessages = (): Message[] => {
    return history.filter(
      (msg) => msg.metadata?.sourceInstanceId === instanceId
    );
  };

  // Create context with helpers
  const ctx: CommandContext<unknown> = {
    state: currentState,
    updateState,
    instanceId,
    getInstanceMessages,
    cede,
    spawn,
    suspend,
  };

  try {
    // Execute the command
    const cmdResult = await command.execute(parsed.data, ctx);

    // Handle value result - just state update + value return
    if (isValueResult(cmdResult)) {
      const updatedInstance: Instance = { ...instance, state: currentState };
      return {
        result: { success: true, value: cmdResult.value },
        instance: updatedInstance,
      };
    }

    // Handle tool reply - returns messages for user and LLM
    if (isToolReply(cmdResult)) {
      const updatedInstance: Instance = { ...instance, state: currentState };
      return {
        result: { success: true },
        instance: updatedInstance,
        replyMessages: {
          userMessage: cmdResult.userMessage,
          llmMessage: cmdResult.llmMessage,
        },
      };
    }

    // Handle transition result
    if (isTransitionToResult(cmdResult)) {
      const newNode = cmdResult.node;
      const newState = cmdResult.state ?? newNode.initialState;
      const newInstance = createInstance(
        newNode,
        newState,
        undefined,
        instance.packStates,
        cmdResult.executorConfig,
      );
      return {
        result: { success: true },
        instance: newInstance,
        transitionResult: cmdResult,
      };
    }

    // Handle spawn result
    if (isSpawnResult(cmdResult)) {
      const newChildren = cmdResult.children.map((target) =>
        createInstance(
          target.node,
          target.state ?? target.node.initialState,
          undefined,
          undefined,
          target.executorConfig,
        ),
      );
      const updatedInstance: Instance = {
        ...instance,
        state: currentState,
        children: newChildren.length === 0 ? undefined : newChildren,
      };
      return {
        result: { success: true },
        instance: updatedInstance,
        transitionResult: cmdResult,
      };
    }

    // Handle cede result
    if (isCedeResult(cmdResult)) {
      // Return the cede result - caller must handle removing this instance
      return {
        result: { success: true, value: cmdResult.content },
        instance: { ...instance, state: currentState },
        transitionResult: cmdResult,
      };
    }

    // Handle suspend result
    if (isSuspendResult(cmdResult)) {
      const suspendInfo = createSuspendInfo(cmdResult);
      const updatedInstance: Instance = {
        ...instance,
        state: currentState,
        suspended: suspendInfo,
      };
      return {
        result: { success: true },
        instance: updatedInstance,
        transitionResult: cmdResult,
        suspendInfo,
      };
    }

    // Handle resume result
    if (isResumeResult(cmdResult)) {
      const updatedInstance: Instance = {
        ...clearSuspension(instance),
        state: currentState,
      };
      return {
        result: { success: true },
        instance: updatedInstance,
        transitionResult: cmdResult,
      };
    }

    return {
      result: { success: false, error: "Unknown command result type" },
      instance,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: { success: false, error: message },
      instance,
    };
  }
}
