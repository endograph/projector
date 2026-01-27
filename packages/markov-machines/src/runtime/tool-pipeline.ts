/**
 * Tool Pipeline - Reusable tool call → state update → transition → messages flow.
 *
 * This module extracts the complete tool processing pipeline from StandardExecutor
 * so it can be reused by other executors (e.g., LiveKitExecutor) that receive
 * tool calls from external sources (not from their own LLM inference).
 */

import type { Charter } from "../types/charter.js";
import type { Instance, SuspendInfo } from "../types/instance.js";
import type { Node } from "../types/node.js";
import type { MachineMessage, ToolResultBlock, TextBlock, OutputBlock, MessageSource } from "../types/messages.js";
import type { StandardNodeConfig, EnqueueFn } from "../executor/types.js";
import { userMessage, assistantMessage, instanceMessage } from "../types/messages.js";
import { processToolCalls, type ToolCall, type ToolCallContext } from "./tool-call-processor.js";
import { executeTransition } from "./transition-executor.js";
import { handleTransitionResult } from "./transition-handler.js";

/**
 * Context for running the tool pipeline.
 */
export interface ToolPipelineContext<AppMessage = unknown> {
  /** The charter (for ref resolution) */
  charter: Charter<AppMessage>;
  /** The current node instance */
  instance: Instance;
  /** Parent instances for ref resolution (from root to parent) */
  ancestors: Instance[];
  /** Current pack states (from root instance) */
  packStates: Record<string, unknown>;
  /** Conversation history (for getInstanceMessages in tools) */
  history?: MachineMessage<AppMessage>[];
  /**
   * Function to enqueue messages directly to machine queue.
   * When provided, pipeline will enqueue messages instead of returning them.
   */
  enqueue?: EnqueueFn<AppMessage>;
  /** Source attribution for messages */
  source?: MessageSource;
}

/**
 * Result of running the tool pipeline.
 * When enqueue is provided in context, messages are enqueued directly
 * and this result only contains the yield reason.
 */
export interface ToolPipelineResult<AppMessage = unknown> {
  /** Why the pipeline yielded */
  yieldReason: "tool_use" | "end_turn" | "cede" | "suspend";
}

/**
 * Run the tool pipeline: process tool calls → update state → execute transitions → enqueue messages.
 *
 * This is the core logic extracted from StandardExecutor.run() that handles:
 * 1. Processing each tool call (updateState, transitions, regular tools)
 * 2. Executing any queued transition
 * 3. Enqueueing instance messages for state/transition/spawn/cede/suspend
 * 4. Enqueueing conversation messages (tool results + assistant content)
 *
 * All messages are enqueued via ctx.enqueue. The enqueue function must be provided.
 *
 * @param ctx - The pipeline context (charter, instance, ancestors, enqueue, etc.)
 * @param toolCalls - Array of tool calls to process
 * @returns The pipeline result with yield reason
 */
export async function runToolPipeline<AppMessage = unknown>(
  ctx: ToolPipelineContext<AppMessage>,
  toolCalls: ToolCall[],
): Promise<ToolPipelineResult<AppMessage>> {
  const { charter, instance, ancestors, history, enqueue, source } = ctx;
  
  if (!enqueue) {
    throw new Error("runToolPipeline requires enqueue function in context");
  }

  let currentState = instance.state;
  let currentNode: Node<any, unknown> = instance.node;
  let packStates = { ...ctx.packStates };

  // Process tool calls
  const toolCallCtx: ToolCallContext = {
    charter,
    instance,
    ancestors,
    packStates,
    currentState,
    currentNode,
    history,
  };

  const toolResult = await processToolCalls<AppMessage>(toolCallCtx, toolCalls);

  // Emit state update if state changed
  if (toolResult.currentState !== currentState) {
    const statePatch = toolResult.currentState as Record<string, unknown>;
    enqueue([instanceMessage<AppMessage>(
      { kind: "state", instanceId: instance.id, patch: statePatch },
      source,
    )]);
    currentState = toolResult.currentState;
  }

  // Emit pack state updates
  for (const [packName, packState] of Object.entries(toolResult.packStates)) {
    if (packState !== ctx.packStates[packName]) {
      enqueue([instanceMessage<AppMessage>(
        { kind: "packState", packName, patch: packState as Record<string, unknown> },
        source,
      )]);
    }
  }
  packStates = toolResult.packStates;

  // Enqueue tool results (role: user)
  if (toolResult.toolResults.length > 0) {
    const toolResultMsg = userMessage<AppMessage>(toolResult.toolResults, source ? { source } : undefined);
    enqueue([toolResultMsg]);
  }

  // Enqueue assistant messages from toolReply (role: assistant)
  if (toolResult.assistantMessages.length > 0) {
    const assistantMsg = assistantMessage<AppMessage>(toolResult.assistantMessages, source ? { source } : undefined);
    enqueue([assistantMsg]);
  }

  // Determine yield reason
  let yieldReason: "tool_use" | "end_turn" | "cede" | "suspend" = "tool_use";

  // Handle terminal tools - force end turn immediately
  if (toolResult.terminal) {
    yieldReason = "end_turn";
  } else if (toolResult.queuedTransition) {
    // Execute the queued transition
    const transition = currentNode.transitions[toolResult.queuedTransition.name];
    if (!transition) {
      throw new Error(`Unknown transition: ${toolResult.queuedTransition.name}`);
    }

    const result = await executeTransition(
      charter,
      transition,
      currentState,
      toolResult.queuedTransition.reason,
      toolResult.queuedTransition.args,
    );

    // Handle transition result and emit appropriate instance message
    const outcome = handleTransitionResult(
      result,
      currentNode,
      currentState,
      instance.children,
    );

    yieldReason = outcome.yieldReason;

    // Emit instance message based on transition outcome
    switch (yieldReason) {
      case "cede":
        enqueue([instanceMessage<AppMessage>(
          { kind: "cede", instanceId: instance.id, content: outcome.cedeContent as string | MachineMessage<AppMessage>[] | undefined },
          source,
        )]);
        break;

      case "suspend":
        if (outcome.suspendInfo) {
          enqueue([instanceMessage<AppMessage>(
            { kind: "suspend", instanceId: instance.id, suspendInfo: outcome.suspendInfo },
            source,
          )]);
        }
        break;

      case "tool_use":
        // Check if this was a spawn or transition
        if (outcome.children && outcome.children.length > (instance.children?.length ?? 0)) {
          // Spawn - emit spawn message for new children
          const newChildren = outcome.children.slice(instance.children?.length ?? 0);
          enqueue([instanceMessage<AppMessage>(
            {
              kind: "spawn",
              parentInstanceId: instance.id,
              children: newChildren.map(c => ({
                node: c.node,
                state: c.state,
                executorConfig: c.executorConfig,
              })),
            },
            source,
          )]);
        } else if (outcome.node !== currentNode) {
          // Transition to new node
          enqueue([instanceMessage<AppMessage>(
            {
              kind: "transition",
              instanceId: instance.id,
              node: outcome.node,
              state: outcome.state,
              executorConfig: outcome.executorConfig,
            },
            source,
          )]);
        }
        break;
    }
  }

  return { yieldReason };
}
