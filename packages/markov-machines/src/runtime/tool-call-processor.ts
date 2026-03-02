import type { Charter } from "../types/charter";
import type { Instance } from "../types/instance";
import type { Node } from "../types/node";
import type {
  MachineMessage,
  ToolResultBlock,
  TextBlock,
  OutputBlock,
} from "../types/messages";
import type { Tracer } from "../types/tracer";
import { toolResult } from "../types/messages";
import { updateState } from "./state-manager";
import { executeTool } from "./tool-executor";
import { resolveTool } from "./ref-resolver";
import {
  isAnthropicBuiltinTool,
  isToolReply,
  type AnyToolDefinition,
  type AnthropicBuiltinTool,
} from "../types/tools";
import type { AnyPackToolDefinition } from "../types/pack";
import { getOrInitPackState } from "../core/machine";

// Tool name constants
const TOOL_UPDATE_STATE = "updateState";
const TOOL_TRANSITION = "transition";
const TRANSITION_PREFIX = "transition_";

export interface ToolCallContext {
  charter: Charter<any>;
  instance: Instance;
  ancestors: Instance[];
  packStates: Record<string, unknown>;
  currentState: unknown;
  currentNode: Node<any, unknown>;
  /** Conversation history for getInstanceMessages */
  history?: MachineMessage<unknown>[];
  /** ID of the root instance in the ancestor chain */
  rootInstanceId?: string;
  /** Optional tracer for observability spans. */
  tracer?: Tracer;
}

export interface ToolCallResult<AppMessage = unknown> {
  toolResults: ToolResultBlock[];
  /** Assistant messages from toolReply userMessage (should be role: assistant) */
  assistantMessages: (TextBlock | OutputBlock<AppMessage>)[];
  currentState: unknown;
  /** Accumulated patch for currentState (shallow merge of successful updateState calls) */
  currentStatePatch?: Record<string, unknown>;
  packStates: Record<string, unknown>;
  /** Accumulated patches for pack states (packName -> shallow merged patch) */
  packStatePatches: Record<string, Record<string, unknown>>;
  queuedTransition?: { name: string; reason: string; args: unknown };
  /** If true, a terminal tool was called and the turn should end immediately */
  terminal?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

// Internal result types for helper functions
interface UpdateStateResult {
  newState: unknown;
  toolResult: ToolResultBlock;
  appliedPatch?: Record<string, unknown>;
}

interface TransitionResult {
  queuedTransition?: { name: string; reason: string; args: unknown };
  toolResult: ToolResultBlock;
}

interface RegularToolResult {
  newCurrentState: unknown;
  toolResult: ToolResultBlock;
  currentStatePatch?: Record<string, unknown>;
  packStatePatch?: { packName: string; patch: Record<string, unknown> };
  /** Assistant content from toolReply userMessage (should be role: assistant) */
  assistantContent?: TextBlock | OutputBlock<any>;
  /** If true, this tool is terminal and the turn should end */
  terminal?: boolean;
}

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
 * Handle the updateState built-in tool.
 */
function handleUpdateStateTool(
  id: string,
  toolInput: unknown,
  currentState: unknown,
  validator: Node<any, unknown>["validator"],
): UpdateStateResult {
  const patch = (toolInput as { patch: Partial<unknown> }).patch;
  const result = updateState(currentState, patch, validator);

  if (result.success) {
    return {
      newState: result.state,
      toolResult: toolResult(id, "State updated successfully"),
      appliedPatch: patch as Record<string, unknown>,
    };
  }
  return {
    newState: currentState,
    toolResult: toolResult(id, `State update failed: ${result.error}`, true),
  };
}

/**
 * Handle transition tools (both default 'transition' and named 'transition_*').
 */
function handleTransitionTool(
  id: string,
  name: string,
  toolInput: unknown,
  existingTransition: { name: string; reason: string; args: unknown } | undefined,
): TransitionResult {
  if (existingTransition) {
    return {
      queuedTransition: existingTransition,
      toolResult: toolResult(id, "Only one transition allowed per turn", true),
    };
  }

  if (name === TOOL_TRANSITION) {
    const { to, reason } = toolInput as { to: string; reason: string };
    return {
      queuedTransition: { name: to, reason, args: {} },
      toolResult: toolResult(id, `Transition to "${to}" complete. You are now in the new context - respond to the user.`),
    };
  }

  // Named transition (transition_*)
  const transitionName = name.slice(TRANSITION_PREFIX.length);
  const { reason, ...args } = toolInput as {
    reason: string;
    [key: string]: unknown;
  };
  return {
    queuedTransition: { name: transitionName, reason, args },
    toolResult: toolResult(id, `Transition to "${transitionName}" complete. You are now in the new context - respond to the user.`),
  };
}

/**
 * Handle a regular (non-builtin) tool call.
 * This includes pack tools and node/ancestor tools.
 */
async function handleRegularTool(
  id: string,
  toolInput: unknown,
  tool: AnyToolDefinition<unknown> | AnyPackToolDefinition | AnthropicBuiltinTool,
  owner: "charter" | { pack: string } | Instance,
  ctx: ToolCallContext,
  currentState: unknown,
  packStates: Record<string, unknown>,
): Promise<RegularToolResult | null> {
  // Check if this is a pack tool
  if (typeof owner === "object" && "pack" in owner) {
    const packName = owner.pack;
    // Look up pack from charter first, then from current node's packs
    const pack =
      ctx.charter.packs.find((p) => p.name === packName) ??
      ctx.currentNode.packs?.find((p) => p.name === packName);
    if (!pack) {
      return {
        newCurrentState: currentState,
        toolResult: toolResult(id, `Pack not found: ${packName}`, true),
      };
    }
    let packState = getOrInitPackState(packStates, pack);
    let packStatePatch: Record<string, unknown> | undefined;

    // Execute pack tool with pack context
    try {
      const packTool = tool as AnyPackToolDefinition;

      // Validate input if pack tool has inputSchema
      if (packTool.inputSchema) {
        const parseResult = packTool.inputSchema.safeParse(toolInput);
        if (!parseResult.success) {
          return {
            newCurrentState: currentState,
            toolResult: toolResult(id, `Invalid pack tool input: ${parseResult.error.message}`, true),
          };
        }
      }

      // Track pack state validation errors
      let packStateError: string | undefined;

      const result = await packTool.execute(toolInput, {
        state: packState,
        updateState: (patch: Partial<unknown>) => {
          const result = updateState(
            packState as Record<string, unknown>,
            patch as Partial<Record<string, unknown>>,
            pack.validator as any,
          );
          if (result.success) {
            packState = result.state;
            packStates[packName] = result.state;
            packStatePatch = mergePatch(
              packStatePatch,
              patch as Partial<Record<string, unknown>>,
            );
            packStateError = undefined; // Clear any prior error
          } else {
            packStateError = `Pack state validation failed: ${result.error}`;
          }
        },
        rootInstanceId: ctx.rootInstanceId,
      });

      // If there was a pack state validation error, include it in the result
      if (packStateError) {
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        return {
          newCurrentState: currentState,
          toolResult: toolResult(id, `${resultStr}\n\nError: ${packStateError}`, true),
          ...(packStatePatch
            ? { packStatePatch: { packName, patch: packStatePatch } }
            : {}),
        };
      }

      // Handle ToolReply from pack tools
      if (isToolReply(result)) {
        const assistantContent =
          typeof result.userMessage === "string"
            ? { type: "text" as const, text: result.userMessage }
            : { type: "output" as const, data: result.userMessage };

        return {
          newCurrentState: currentState,
          toolResult: toolResult(id, result.llmMessage),
          ...(packStatePatch
            ? { packStatePatch: { packName, patch: packStatePatch } }
            : {}),
          assistantContent,
          terminal: packTool.terminal,
        };
      }

      return {
        newCurrentState: currentState,
        toolResult: toolResult(id, typeof result === "string" ? result : JSON.stringify(result)),
        ...(packStatePatch
          ? { packStatePatch: { packName, patch: packStatePatch } }
          : {}),
        terminal: packTool.terminal,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        newCurrentState: currentState,
        toolResult: toolResult(id, `Tool error: ${errorMsg}`, true),
        ...(packStatePatch
          ? { packStatePatch: { packName, patch: packStatePatch } }
          : {}),
      };
    }
  }

  // Skip Anthropic builtin tools (handled server-side)
  if (isAnthropicBuiltinTool(tool)) {
    return null;
  }

  // Non-pack tool - determine which state to use and how to update it
  // Check if this is a current-node tool (charter-level or same node as current)
  const isCurrentNodeTool =
    owner === "charter" ||
    owner.node.id === ctx.currentNode.id;

  let toolState: unknown;
  let newCurrentState = currentState;
  let currentStatePatch: Record<string, unknown> | undefined;
  let onUpdate: (patch: Partial<unknown>) => void;

  if (isCurrentNodeTool) {
    toolState = currentState;
    onUpdate = (patch) => {
      const result = updateState(
        newCurrentState,
        patch,
        ctx.currentNode.validator,
      );
      if (result.success) {
        newCurrentState = result.state;
        currentStatePatch = mergePatch(
          currentStatePatch,
          patch as Partial<Record<string, unknown>>,
        );
      }
    };
  } else {
    // Ancestor tool - read-only state access
    // State updates from ancestor tools are not supported (changes would be lost)
    toolState = owner.state;
    onUpdate = () => {
      throw new Error(
        `Cannot update ancestor state from tool. Ancestor state updates are not supported.`,
      );
    };
  }

  const {
    result: toolResultStr,
    isError,
    userMessage,
    terminal,
  } = await executeTool(tool, toolInput, toolState, onUpdate, ctx.instance.id, ctx.history ?? [], ctx.rootInstanceId);

  const toolResultBlock = toolResult(id, toolResultStr, isError);

  // Build assistant content if userMessage present (from toolReply)
  let assistantContent: TextBlock | OutputBlock<unknown> | undefined;
  if (userMessage !== undefined) {
    assistantContent =
      typeof userMessage === "string" ? { type: "text", text: userMessage } : { type: "output", data: userMessage };
  }

  return {
    newCurrentState,
    toolResult: toolResultBlock,
    ...(currentStatePatch ? { currentStatePatch } : {}),
    assistantContent,
    terminal,
  };
}

/**
 * Process tool calls from an API response.
 * Handles updateState, transitions, pack tools, and regular node tools.
 */
export async function processToolCalls<AppMessage = unknown>(
  ctx: ToolCallContext,
  toolCalls: ToolCall[],
): Promise<ToolCallResult<AppMessage>> {
  const toolResults: ToolResultBlock[] = [];
  const assistantMessages: (TextBlock | OutputBlock<AppMessage>)[] = [];
  let terminal = false;
  let currentState = ctx.currentState;
  let currentStatePatch: Record<string, unknown> | undefined;
  const packStates = { ...ctx.packStates };
  const packStatePatches: Record<string, Record<string, unknown>> = {};
  let queuedTransition: { name: string; reason: string; args: unknown } | undefined;

  const tracer = ctx.tracer;

  for (const { id, name, input: toolInput } of toolCalls) {
    // Handle updateState
    if (name === TOOL_UPDATE_STATE) {
      const execUpdateState = () => {
        const result = handleUpdateStateTool(
          id,
          toolInput,
          currentState,
          ctx.currentNode.validator,
        );
        currentState = result.newState;
        if (result.appliedPatch) {
          currentStatePatch = mergePatch(currentStatePatch, result.appliedPatch);
        }
        toolResults.push(result.toolResult);
        return result;
      };

      if (tracer) {
        await tracer.withSpan("tool.updateState", (span) => {
          const result = execUpdateState();
          span.log({
            input: { patch: (toolInput as any)?.patch },
            output: {
              success: result.appliedPatch !== undefined,
              appliedPatch: result.appliedPatch,
              error: result.appliedPatch ? undefined : result.toolResult.content,
              newState: result.newState,
            },
          });
        });
      } else {
        execUpdateState();
      }
      continue;
    }

    // Handle transition tools
    if (name === TOOL_TRANSITION || name.startsWith(TRANSITION_PREFIX)) {
      const transitionName = name === TOOL_TRANSITION
        ? (toolInput as any)?.to
        : name.slice(TRANSITION_PREFIX.length);

      const execTransition = () => {
        const result = handleTransitionTool(id, name, toolInput, queuedTransition);
        queuedTransition = result.queuedTransition;
        toolResults.push(result.toolResult);
        return result;
      };

      if (tracer) {
        await tracer.withSpan(`tool.transition.${transitionName}`, (span) => {
          const wasAlreadyQueued = !!queuedTransition;
          const result = execTransition();
          span.log({
            input: { name: transitionName, rawInput: toolInput },
            output: {
              queued: !!result.queuedTransition && !wasAlreadyQueued,
              rejected: wasAlreadyQueued,
              queuedTransition: result.queuedTransition,
            },
          });
        });
      } else {
        execTransition();
      }
      continue;
    }

    // Check if this is an Anthropic builtin tool (server-side, handled by API)
    const nodeToolEntry = ctx.currentNode.tools[name];
    if (nodeToolEntry && isAnthropicBuiltinTool(nodeToolEntry)) {
      continue;
    }

    // Resolve and execute tool (walks up ancestor tree)
    const resolved = resolveTool(
      ctx.charter,
      { id: ctx.instance.id, node: ctx.currentNode, state: currentState },
      ctx.ancestors,
      name,
    );

    if (resolved) {
      const execRegularTool = async () => {
        const result = await handleRegularTool(
          id,
          toolInput,
          resolved.tool,
          resolved.owner,
          ctx,
          currentState,
          packStates,
        );
        if (result) {
          currentState = result.newCurrentState;
          if (result.currentStatePatch) {
            currentStatePatch = mergePatch(currentStatePatch, result.currentStatePatch);
          }
          if (result.packStatePatch) {
            const { packName, patch } = result.packStatePatch;
            packStatePatches[packName] = mergePatch(packStatePatches[packName], patch);
          }
          toolResults.push(result.toolResult);
          if (result.assistantContent) {
            assistantMessages.push(result.assistantContent);
          }
          if (result.terminal) {
            terminal = true;
          }
        }
        return result;
      };

      if (tracer) {
        await tracer.withSpan(`tool.${name}`, async (span) => {
          const result = await execRegularTool();
          if (result) {
            const content = result.toolResult.content;
            span.log({
              input: toolInput,
              output: {
                result: typeof content === "string" && content.length > 500
                  ? content.slice(0, 500) + "..."
                  : content,
                isError: result.toolResult.is_error,
                terminal: result.terminal,
              },
            });
          }
        });
      } else {
        await execRegularTool();
      }
      continue;
    }

    // Unknown tool
    toolResults.push(toolResult(id, `Unknown tool: ${name}`, true));
  }

  return {
    toolResults,
    assistantMessages,
    currentState,
    ...(currentStatePatch ? { currentStatePatch } : {}),
    packStates,
    packStatePatches,
    queuedTransition,
    terminal,
  };
}
