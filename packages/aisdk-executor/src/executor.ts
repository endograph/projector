import { Output, generateText, streamText, stepCountIs, tool, type ModelMessage, type ToolSet } from "ai";
import type {
  ActionContext,
  ActorMessage,
  AnyOutputConfig,
  AnyAction,
  CompiledInference,
  ExecutorRunRequest,
  ExecutorRunResult,
  FrameMessage,
  ProjectorExecutor,
} from "@projectors/core";
import { z } from "zod";
import type { AiSdkExecutorConfig } from "./types.ts";

const DEFAULT_MAX_STEPS = 5;

export class AiSdkExecutor implements ProjectorExecutor {
  readonly type = "aisdk";

  constructor(readonly config: AiSdkExecutorConfig) {}

  async run(request: ExecutorRunRequest): Promise<ExecutorRunResult> {
    if (request.signal?.aborted) {
      return { completionReason: "cancelled" };
    }

    const generate = this.config.generateText ?? generateText;
    const stream = this.config.streamText ?? streamText;
    const tools = buildAiSdkTools(request, this.config);
    const hasTools = Object.keys(tools).length > 0;
    const input = {
      model: this.config.model,
      system: buildAiSdkSystem(request.inference),
      messages: buildAiSdkMessages(request.inference),
      tools: hasTools ? tools : undefined,
      abortSignal: request.signal,
      maxOutputTokens: this.config.maxOutputTokens,
      temperature: this.config.temperature,
      topP: this.config.topP,
      topK: this.config.topK,
      presencePenalty: this.config.presencePenalty,
      frequencyPenalty: this.config.frequencyPenalty,
      seed: this.config.seed,
      experimental_output: request.output?.schema
        ? Output.object({ schema: request.output.schema })
        : undefined,
      providerOptions: this.config.providerOptions as never,
      toolChoice: this.config.toolChoice as never,
      stopWhen: hasTools ? stepCountIs(this.config.maxSteps ?? DEFAULT_MAX_STEPS) : undefined,
    };

    try {
      if (shouldStream(this.config.stream, request)) {
        return await this.runStreaming(request, stream, input as never);
      }

      const result = await generate(input);

      const text = typeof result.text === "string" ? result.text : "";
      return {
        completionReason: "done",
        ...(text.trim() ? { value: text } : {}),
      };
    } catch (error) {
      if (isAbortError(error) || request.signal?.aborted) {
        return { completionReason: "cancelled" };
      }
      throw error;
    }
  }

  private async runStreaming(
    request: ExecutorRunRequest,
    stream: NonNullable<AiSdkExecutorConfig["streamText"]>,
    input: Parameters<NonNullable<AiSdkExecutorConfig["streamText"]>>[0],
  ): Promise<ExecutorRunResult> {
    const messageId = crypto.randomUUID();
    let seq = 0;
    let text = "";

    emitStreamUpdate(this.config, {
      request,
      messageId,
      text,
      streamState: "streaming",
      streamSeq: seq,
    });

    const result = stream(input);
    try {
      for await (const delta of result.textStream) {
        if (!delta) continue;
        text += delta;
        seq += 1;
        emitStreamUpdate(this.config, {
          request,
          messageId,
          text,
          delta,
          streamState: "streaming",
          streamSeq: seq,
        });
      }
    } catch (error) {
      seq += 1;
      emitStreamUpdate(this.config, {
        request,
        messageId,
        text,
        streamState: "error",
        streamSeq: seq,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const finalText = text || await result.text;
    const finalSeq = seq + 1;

    return {
      completionReason: "done",
      ...(finalText.trim()
        ? {
            frames: [
              {
                messages: [
                  outputMessageFromText(finalText, request.output, {
                    messageId,
                    streamState: "complete",
                    streamSeq: finalSeq,
                  }),
                ],
              },
            ],
          }
        : {}),
    };
  }
}

function emitStreamUpdate(
  config: AiSdkExecutorConfig,
  update: Parameters<NonNullable<AiSdkExecutorConfig["onStreamUpdate"]>>[0],
): void {
  if (!config.onStreamUpdate) return;
  void Promise.resolve()
    .then(() => config.onStreamUpdate?.(update))
    .catch((error) => {
      if (config.debug) {
        console.warn("[aisdk-executor] stream update failed", error);
      }
    });
}

function shouldStream(
  stream: AiSdkExecutorConfig["stream"],
  request: ExecutorRunRequest,
): boolean {
  if (typeof stream === "function") return stream(request);
  return stream === true;
}

export function buildAiSdkSystem(inference: CompiledInference): string {
  return [
    renderSection("System", inference.systemParts),
    renderSection("Dynamic Context", inference.dynamicParts),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildAiSdkMessages(inference: CompiledInference): ModelMessage[] {
  return inference.history.map(actorMessageToModelMessage);
}

export function buildAiSdkTools(
  request: ExecutorRunRequest,
  config: AiSdkExecutorConfig,
): ToolSet {
  const tools: ToolSet = {};

  for (const action of request.inference.tools) {
    tools[action.name] = tool({
      description: action.description ?? "",
      inputSchema: action.inputSchema ?? z.object({}),
      strict: config.toolStrict ?? false,
      execute: (input, aiSdkContext) => executeAction(action, input, request, config, aiSdkContext),
    });
  }

  return tools;
}

async function executeAction(
  action: AnyAction,
  input: unknown,
  request: ExecutorRunRequest,
  config: AiSdkExecutorConfig,
  aiSdkContext: unknown,
): Promise<unknown> {
  const context: ActionContext<unknown> = request.createActionContext?.(action) ?? {};
  let output: unknown;
  if (config.runAction) {
    output = await config.runAction({ action, input, context, request, aiSdkContext });
  } else {
    output = await action.run?.(input as never, context as never);
  }
  const messages = actionResultMessages(output);
  if (messages.length > 0) {
    await request.enqueueFrame({
      generatorId: request.generatorId,
      runtimeInstanceId: request.runtimeInstanceId,
      activationId: request.activationId,
      messages,
    });
  }
  return output;
}

function actionResultMessages(value: unknown): FrameMessage[] {
  if (Array.isArray(value)) {
    return value.filter(isFrameMessageLike) as FrameMessage[];
  }
  return isFrameMessageLike(value) ? [value as FrameMessage] : [];
}

function isFrameMessageLike(value: unknown): value is { type: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string",
  );
}

function actorMessageToModelMessage(message: ActorMessage): ModelMessage {
  if (message.type === "user") {
    return { role: "user", content: message.text };
  }
  if (message.type === "assistant") {
    return { role: "assistant", content: message.text };
  }
  return { role: "user", content: renderToolMessage(message) };
}

function outputMessageFromText(
  text: string,
  output: AnyOutputConfig | undefined,
  metadata: Record<string, unknown>,
): FrameMessage {
  const mapped = output?.mapTextBlock
    ? output.mapTextBlock(text)
    : {
        type: "assistant",
        text,
      };
  const parsed = output?.schema ? output.schema.parse(mapped) : mapped;
  const withAudience = applyOutputAudience(parsed, output?.audience);
  if (!isFrameMessageLike(withAudience)) {
    throw new Error("Output mapper must return a frame message");
  }

  return {
    ...withAudience,
    ...metadata,
  } as FrameMessage;
}

function applyOutputAudience(
  message: unknown,
  audience: AnyOutputConfig["audience"],
): unknown {
  if (!audience || !message || typeof message !== "object") {
    return message;
  }

  const record = message as Record<string, unknown>;
  if (record.audience !== undefined) {
    return message;
  }

  if (record.type === "user" || record.type === "assistant" || record.type === "tool") {
    return { ...record, audience };
  }

  return message;
}

function renderToolMessage(message: Extract<ActorMessage, { type: "tool" }>): string {
  const value = message.text ?? stringifyValue(message.value);
  return value ? `Tool ${message.name}: ${value}` : `Tool ${message.name}`;
}

function renderSection(title: string, parts: string[]): string {
  const body = parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
  return body ? `## ${title}\n\n${body}` : "";
}

function stringifyValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return record.name === "AbortError" || record.name === "TimeoutError";
}
