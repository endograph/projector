import type { Charter } from "../types/charter.js";
import type { Instance } from "../types/instance.js";
import type { Node } from "../types/node.js";
import type {
  MachineMessage,
  ToolResultBlock,
  TextBlock,
  OutputBlock,
} from "../types/messages.js";
import { toolResult } from "../types/messages.js";
import { updateState } from "./state-manager.js";
import { executeTool } from "./tool-executor.js";
import { resolveTool } from "./ref-resolver.js";
import {
  isAnthropicBuiltinTool,
  type AnyToolDefinition,
  type AnthropicBuiltinTool,
} from "../types/tools.js";
import type { AnyPackToolDefinition } from "../types/pack.js";
import { getOrInitPackState } from "../core/machine.js";

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
}

export interface ToolCallResult<AppMessage = unknown> {
  toolResults: ToolResultBlock[];
  /** Assistant messages from toolReply userMessage (should be role: assistant) */
  assistantMessages: (TextBlock | OutputBlock<AppMessage>)[];
  currentState: unknown;
  packStates: Record<string, unknown>;
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
}

interface TransitionResult {
  queuedTransition?: { name: string; reason: string; args: unknown };
  toolResult: ToolResultBlock;
}

interface RegularToolResult {
  newCurrentState: unknown;
  toolResult: ToolResultBlock;
  /** Assistant content from toolReply userMessage (should be role: assistant) */
  assistantContent?: TextBlock | OutputBlock<any>;
  /** If true, this tool is terminal and the turn should end */
  terminal?: boolean;
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
    const packState = getOrInitPackState(packStates, pack);

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
          // Validate and update pack state
          const merged = { ...(packState ?? {}), ...patch };
          const parseResult = pack.validator.safeParse(merged);
          if (parseResult.success) {
            packStates[packName] = parseResult.data;
          } else {
            packStateError = `Pack state validation failed: ${parseResult.error.message}`;
          }
        },
      });

      // If there was a pack state validation error, include it in the result
      if (packStateError) {
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        return {
          newCurrentState: currentState,
          toolResult: toolResult(id, `${resultStr}\n\nError: ${packStateError}`, true),
        };
      }

      return {
        newCurrentState: currentState,
        toolResult: toolResult(id, typeof result === "string" ? result : JSON.stringify(result)),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        newCurrentState: currentState,
        toolResult: toolResult(id, `Tool error: ${errorMsg}`, true),
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
    owner === ctx.instance ||
    owner.node.id === ctx.currentNode.id;

  let toolState: unknown;
  let newCurrentState = currentState;
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
  } = await executeTool(tool, toolInput, toolState, onUpdate, ctx.instance.id, ctx.history ?? []);

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
  const packStates = { ...ctx.packStates };
  let queuedTransition: { name: string; reason: string; args: unknown } | undefined;

  for (const { id, name, input: toolInput } of toolCalls) {
    // Handle updateState
    if (name === TOOL_UPDATE_STATE) {
      const result = handleUpdateStateTool(
        id,
        toolInput,
        currentState,
        ctx.currentNode.validator,
      );
      currentState = result.newState;
      toolResults.push(result.toolResult);
      continue;
    }

    // Handle transition tools
    if (name === TOOL_TRANSITION || name.startsWith(TRANSITION_PREFIX)) {
      const result = handleTransitionTool(id, name, toolInput, queuedTransition);
      queuedTransition = result.queuedTransition;
      toolResults.push(result.toolResult);
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
        toolResults.push(result.toolResult);
        if (result.assistantContent) {
          assistantMessages.push(result.assistantContent);
        }
        if (result.terminal) {
          terminal = true;
        }
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
    packStates,
    queuedTransition,
    terminal,
  };
}
