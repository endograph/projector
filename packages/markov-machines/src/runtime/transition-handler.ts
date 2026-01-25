import type { Instance, SuspendInfo } from "../types/instance.js";
import type { Node } from "../types/node.js";
import type { Message } from "../types/messages.js";
import type { TransitionResult } from "../types/transitions.js";
import {
  isTransitionToResult,
  isSpawnResult,
  isCedeResult,
  isSuspendResult,
} from "../types/transitions.js";
import { createInstance, createSuspendInfo } from "../types/instance.js";
import type { StandardNodeConfig } from "../executor/types.js";

export interface TransitionOutcome {
  node: Node<any, unknown>;
  state: unknown;
  children: Instance[] | undefined;
  executorConfig?: StandardNodeConfig;
  yieldReason: "tool_use" | "cede" | "suspend";
  /** Content from cede (string or Message[]) */
  cedeContent?: string | Message<unknown>[];
  /** Suspend info if yieldReason is "suspend" */
  suspendInfo?: SuspendInfo;
}

/**
 * Handle the result of executing a transition.
 * Returns the outcome including new node/state and yield reason.
 */
export function handleTransitionResult(
  result: TransitionResult<unknown>,
  currentNode: Node<any, unknown>,
  currentState: unknown,
  currentChildren: Instance[] | undefined,
): TransitionOutcome {
  // Handle discriminated union
  if (isCedeResult(result)) {
    // Cede: return with cede yield reason
    return {
      node: currentNode,
      state: currentState,
      children: currentChildren,
      yieldReason: "cede",
      cedeContent: result.content,
    };
  }

  if (isSuspendResult(result)) {
    // Suspend: return with suspend yield reason and info
    return {
      node: currentNode,
      state: currentState,
      children: currentChildren,
      yieldReason: "suspend",
      suspendInfo: createSuspendInfo(result),
    };
  }

  if (isSpawnResult(result)) {
    // Spawn: add children to current instance
    const newChildren = result.children.map(({ node, state, executorConfig: childExecConfig }) =>
      createInstance(
        node,
        state ?? node.initialState,
        undefined, // children
        undefined, // packStates
        childExecConfig ?? node.executorConfig, // Apply config hierarchy
      ),
    );

    // Append to existing children
    const updatedChildren = [...(currentChildren ?? []), ...newChildren];

    return {
      node: currentNode,
      state: currentState,
      children: updatedChildren.length === 0 ? undefined : updatedChildren,
      yieldReason: "tool_use", // More work to do
    };
  }

  if (isTransitionToResult(result)) {
    // Normal transition
    const newNode = result.node;

    // Update state: use returned state, or node's initialState, or throw
    let newState: unknown;
    if (result.state !== undefined) {
      newState = result.state;
    } else if (newNode.initialState !== undefined) {
      newState = newNode.initialState;
    } else {
      throw new Error(
        `Transition returned undefined state and target node has no initialState`,
      );
    }

    return {
      node: newNode,
      state: newState,
      children: undefined, // Clear children on transition to new node
      executorConfig: result.executorConfig ?? newNode.executorConfig,
      yieldReason: "tool_use", // More work to do on new node
    };
  }

  // Should not reach here - exhaustive check
  throw new Error(`Unknown transition result type`);
}
