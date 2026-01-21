import type { AnyToolDefinition, ToolContext } from "../types/tools.js";
import type { Message } from "../types/messages.js";
import { isToolReply } from "../types/tools.js";

/**
 * Result of executing a tool.
 */
export interface ToolExecutionResult {
  result: string;
  isError: boolean;
  /** Message for the user - string or typed M (type erased to unknown at runtime) */
  userMessage?: unknown;
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
  history: Message<unknown>[],
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

    // Create getInstanceMessages function that filters by sourceInstanceId
    const getInstanceMessages = (): Message[] => {
      return history.filter(
        (msg) => msg.metadata?.sourceInstanceId === instanceId
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
      };
    }

    // Convert output to string
    const resultStr =
      typeof output === "string" ? output : JSON.stringify(output);

    return { result: resultStr, isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { result: `Tool execution error: ${message}`, isError: true };
  }
}