import type { AnyToolDefinition, ToolContext } from "../types/tools.js";
import type { MachineMessage } from "../types/messages.js";
import { isToolReply } from "../types/tools.js";

/**
 * Result of executing a tool.
 */
export interface ToolExecutionResult {
  result: string;
  isError: boolean;
  /** Message for the user - string or typed M (type erased to unknown at runtime) */
  userMessage?: unknown;
  /** If true, tool execution ends the turn immediately (yields end_turn) */
  terminal?: boolean;
}

/**
 * Execute a tool with the given input and state.
 * @param tool - The tool to execute
 * @param input - The input to pass to the tool
 * @param state - The current state
 * @param onStateUpdate - Callback for state updates
 * @param instanceId - ID of the instance executing the tool
 * @param history - Conversation history for getInstanceMessages
 */
export async function executeTool<S>(
  tool: AnyToolDefinition<S>,
  input: unknown,
  state: S,
  onStateUpdate: (patch: Partial<S>) => void,
  instanceId: string,
  history: MachineMessage<unknown>[],
): Promise<ToolExecutionResult> {
  try {
    // Validate input
    const inputResult = tool.inputSchema.safeParse(input);
    if (!inputResult.success) {
      return {
        result: `Invalid tool input: ${inputResult.error.message}`,
        isError: true,
      };
    }

    // Create getInstanceMessages function that filters by source.instanceId
    const getInstanceMessages = (): MachineMessage[] => {
      return history.filter(
        (msg) => msg.metadata?.source?.instanceId === instanceId
      );
    };

    // Create context
    const ctx: ToolContext<S> = {
      state,
      updateState: onStateUpdate,
      instanceId,
      getInstanceMessages,
    };

    // Execute tool
    const output = await tool.execute(inputResult.data, ctx);

    // Handle ToolReply - extract separate user and LLM messages
    if (isToolReply(output)) {
      return {
        result: output.llmMessage,
        isError: false,
        userMessage: output.userMessage,
        terminal: tool.terminal,
      };
    }

    // Convert output to string
    const resultStr =
      typeof output === "string" ? output : JSON.stringify(output);

    return { result: resultStr, isError: false, terminal: tool.terminal };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { result: `Tool execution error: ${message}`, isError: true };
  }
}