import { assertProjectorIdentifier } from "./identifiers.ts";
import type {
  ActorHistoryProjection,
  ActorMessage,
  Frame,
  FrameDraft,
  FrameMessage,
  GeneratorId,
  HistoryProjection,
  HistoryProjectionContext,
  HistoryProjectionFunction,
  HistoryProjectionFunctionMethod,
  DataContentPart,
  MessageHistoryProjection,
  UserMessage,
  AssistantMessage,
  Audience,
  ImageContentPart,
  MessageDelivery,
  OutputConfig,
  RuntimeConcurrency,
  TextContentPart,
  WorkActivationMessage,
  WorkCompletionMessage,
  WorkCompletionReason,
  WorkMessage,
} from "./types.ts";

export function createHistoryProjectionFunction<
  TDataContent = never,
>(config: {
  name: string;
  method: HistoryProjectionFunctionMethod<TDataContent>;
}): HistoryProjectionFunction<TDataContent> {
  assertProjectorIdentifier(config.name, "History projection function name");
  return {
    kind: "historyProjection",
    name: config.name,
    method: config.method,
  };
}

export function isHistoryProjectionFunction<
  TDataContent = never,
>(
  value: unknown,
): value is HistoryProjectionFunction<TDataContent> {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "historyProjection" &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { method?: unknown }).method === "function",
  );
}

export function isActorHistoryProjection(
  projection: HistoryProjection<any>,
): projection is ActorHistoryProjection {
  return (
    typeof projection === "object" &&
    projection !== null &&
    "type" in projection &&
    projection.type === "actor"
  );
}

export function isMessageHistoryProjection(
  projection: HistoryProjection<any>,
): projection is MessageHistoryProjection {
  return (
    typeof projection === "object" &&
    projection !== null &&
    "type" in projection &&
    projection.type === "messages"
  );
}

/**
 * A self-contained turn frame: activation and completion for work that was
 * never scheduled through the machine (e.g. realtime voice turns).
 */
export function createRuntimeTurnFrame<
  TDataContent = never,
>({
  generatorId,
  activationId,
  sourceFrameId,
  reason = "end-turn",
  concurrencyKey = generatorId,
  concurrency = "serial",
  metadata,
}: {
  generatorId: GeneratorId;
  activationId: string;
  sourceFrameId: string;
  reason?: WorkCompletionReason;
  concurrencyKey?: string;
  concurrency?: RuntimeConcurrency;
  /** App/runner frame metadata (see FrameDraft.metadata). */
  metadata?: Record<string, unknown>;
}): FrameDraft<TDataContent> {
  return {
    generatorId,
    activationId,
    ...(metadata ? { metadata } : {}),
    messages: [
      ({
        type: "work",
        kind: "activation",
        activationId,
        generatorId,
        sourceFrameId,
        concurrencyKey,
        concurrency,
      } satisfies WorkActivationMessage) as FrameMessage<TDataContent>,
      ({
        type: "work",
        kind: "completion",
        activationId,
        generatorId,
        sourceFrameId,
        reason,
      } satisfies WorkCompletionMessage) as FrameMessage<TDataContent>,
    ],
  };
}

export function createActivationFrame<
  TDataContent = never,
>({
  activationId,
  generatorId,
  sourceFrameId,
  concurrencyKey,
  concurrency,
}: {
  activationId: string;
  generatorId: GeneratorId;
  sourceFrameId: string;
  concurrencyKey: string;
  concurrency: RuntimeConcurrency;
}): FrameDraft<TDataContent> {
  return {
    messages: [
      ({
        type: "work",
        kind: "activation",
        activationId,
        generatorId,
        sourceFrameId,
        concurrencyKey,
        concurrency,
      } satisfies WorkActivationMessage) as FrameMessage<TDataContent>,
    ],
  };
}

export function createCompletionFrame<
  TDataContent = never,
>({
  activationId,
  generatorId,
  sourceFrameId,
  reason,
}: {
  activationId: string;
  generatorId?: GeneratorId;
  sourceFrameId?: string;
  reason: WorkCompletionReason;
}): FrameDraft<TDataContent> {
  return {
    messages: [
      ({
        type: "work",
        kind: "completion",
        activationId,
        ...(generatorId !== undefined ? { generatorId } : {}),
        ...(sourceFrameId !== undefined ? { sourceFrameId } : {}),
        reason,
      } satisfies WorkCompletionMessage) as FrameMessage<TDataContent>,
    ],
  };
}

export function isWorkMessage(message: unknown): message is WorkMessage {
  return isWorkActivationMessage(message) || isWorkCompletionMessage(message);
}

export function isWorkActivationMessage(message: unknown): message is WorkActivationMessage {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return (
    record.type === "work" &&
    record.kind === "activation" &&
    typeof record.activationId === "string" &&
    typeof record.generatorId === "string" &&
    typeof record.sourceFrameId === "string" &&
    typeof record.concurrencyKey === "string" &&
    (record.concurrency === "serial" || record.concurrency === "parallel")
  );
}

export function isWorkCompletionMessage(message: unknown): message is WorkCompletionMessage {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return (
    record.type === "work" &&
    record.kind === "completion" &&
    typeof record.activationId === "string" &&
    (record.generatorId === undefined || typeof record.generatorId === "string") &&
    (record.sourceFrameId === undefined || typeof record.sourceFrameId === "string") &&
    isWorkCompletionReason(record.reason)
  );
}

export function userMessage<TDataContent = never>(
  content: TDataContent,
  options: {
    text?: string;
    audience?: Audience;
    delivery?: MessageDelivery;
  } = {},
): UserMessage<TDataContent> {
  return {
    type: "user",
    content: [{ type: "data", data: content }],
    ...options,
  };
}

export function assistantMessage<TDataContent = never>(
  content: TDataContent,
  options: {
    text?: string;
    audience?: Audience;
    delivery?: MessageDelivery;
  } = {},
): AssistantMessage<TDataContent> {
  return {
    type: "assistant",
    content: [{ type: "data", data: content }],
    ...options,
  };
}

export function textContent(text: string): TextContentPart {
  return { type: "text", text };
}

export function imageContent(
  data: ImageContentPart["data"],
  options: {
    mediaType: string;
    label?: string;
  },
): ImageContentPart {
  return {
    type: "image",
    data,
    mediaType: options.mediaType,
    ...(options.label ? { label: options.label } : {}),
  };
}

export function dataContent<TDataContent>(
  data: TDataContent,
  options: { label?: string } = {},
): DataContentPart<TDataContent> {
  return {
    type: "data",
    data,
    ...(options.label ? { label: options.label } : {}),
  };
}

export function textUserMessage(text: string): UserMessage {
  return { type: "user", content: [textContent(text)], text };
}

export function textAssistantMessage(text: string): AssistantMessage {
  return { type: "assistant", content: [textContent(text)], text };
}

export function assistantMessageFromTextOutput<TDataContent = never>(
  text: string,
  output: OutputConfig<TDataContent> | undefined,
): AssistantMessage<TDataContent> {
  const schema = output?.schema;
  const mapTextBlock = output?.mapTextBlock;

  if (!schema && !mapTextBlock) {
    return {
      type: "assistant",
      content: [textContent(text)],
      text,
      ...(output?.audience ? { audience: output.audience } : {}),
    };
  }

  if (mapTextBlock) {
    const mapped = mapTextBlock(text);
    const content = schema ? schema.parse(mapped) : mapped;
    return {
      type: "assistant",
      content: [dataContent(content)],
      text,
      ...(output?.audience ? { audience: output.audience } : {}),
    };
  }

  if (schema) {
    return {
      type: "assistant",
      content: [dataContent(schema.parse(text))],
      text,
      ...(output?.audience ? { audience: output.audience } : {}),
    };
  }

  throw new Error("assistantMessageFromTextOutput requires a schema or mapTextBlock for data output.");
}

export function actorMessages<TDataContent = never>(
  ctx: HistoryProjectionContext<TDataContent>,
): ActorMessage<TDataContent>[] {
  return actorMessagesFromFrames<TDataContent>(ctx.history);
}

export function messages<TDataContent = never>(
  ctx: HistoryProjectionContext<TDataContent>,
): FrameMessage<TDataContent>[] {
  return messagesFromFrames<TDataContent>(ctx.history);
}

export function messagesSinceLastCompletion<
  TDataContent = never,
>(
  ctx: HistoryProjectionContext<TDataContent>,
): ActorMessage<TDataContent>[] {
  const index = lastCompletionIndex(ctx.history, ctx.generatorId);
  return actorMessagesFromFrames<TDataContent>(index === -1 ? ctx.history : ctx.history.slice(index + 1));
}

export function messagesBeforeLastCompletion<
  TDataContent = never,
>(
  ctx: HistoryProjectionContext<TDataContent>,
): ActorMessage<TDataContent>[] {
  const index = lastCompletionIndex(ctx.history, ctx.generatorId);
  return index === -1 ? [] : actorMessagesFromFrames<TDataContent>(ctx.history.slice(0, index));
}

export function actorMessagesFromFrames<
  TDataContent = never,
>(frames: readonly Frame<TDataContent>[]): ActorMessage<TDataContent>[] {
  return frames.flatMap((frame) =>
    frame.messages.flatMap((message) => actorMessageFromUnknown<TDataContent>(message))
  );
}

export function messagesFromFrames<TDataContent = never>(
  frames: readonly Frame<TDataContent>[],
): FrameMessage<TDataContent>[] {
  return frames.flatMap((frame) => frame.messages);
}

function lastCompletionIndex<TDataContent>(
  frames: readonly Frame<TDataContent>[],
  generatorId: GeneratorId,
): number {
  const activationGeneratorIds = new Map<string, GeneratorId>();
  let lastIndex = -1;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!frame) continue;
    for (const message of frame.messages) {
      if (isWorkActivationMessage(message)) {
        activationGeneratorIds.set(message.activationId, message.generatorId);
      }
      if (
        isWorkCompletionMessage(message) &&
        (message.generatorId ?? activationGeneratorIds.get(message.activationId)) === generatorId
      ) {
        lastIndex = index;
      }
    }
  }
  return lastIndex;
}

function actorMessageFromUnknown<TDataContent>(
  value: unknown,
): ActorMessage<TDataContent>[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  if (record.type === "user") {
    return [{ ...record, type: "user" } as ActorMessage<TDataContent>];
  }
  if (record.type === "assistant") {
    return [{ ...record, type: "assistant" } as ActorMessage<TDataContent>];
  }
  return [];
}

function isWorkCompletionReason(value: unknown): value is WorkCompletionReason {
  return value === "end-turn" || value === "done" || value === "cancelled" || value === "delegated" || value === "error" || value === "terminal-action" || value === "absorbed";
}
