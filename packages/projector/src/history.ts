import type {
  ActorMessage,
  CompletionReason,
  Frame,
  FrameDraft,
  FrameMessage,
  GeneratorId,
  HistoryProjectionContext,
  DataContentPart,
  UserMessage,
  AssistantMessage,
  Audience,
  ImageContentPart,
  MessageDelivery,
  OutputConfig,
  RuntimeConcurrency,
  RuntimeInstanceId,
  TextContentPart,
  WorkActivationMessage,
  WorkCompletionMessage,
  WorkCompletionReason,
  WorkMessage,
} from "./types.ts";

export type RuntimeCompletionFrameMetadata = {
  type: "projector.runtime-completion";
  runtimeInstanceId: RuntimeInstanceId;
  activationId: string;
  completionReason: CompletionReason;
};

export function createRuntimeCompletionFrame<
  TDataContent = never,
>({
  generatorId,
  runtimeInstanceId,
  activationId,
  completionReason,
  metadata,
}: {
  generatorId: GeneratorId;
  runtimeInstanceId: RuntimeInstanceId;
  activationId: string;
  completionReason: CompletionReason;
  metadata?: Record<string, unknown>;
}): FrameDraft<TDataContent> {
  return {
    generatorId,
    runtimeInstanceId,
    activationId,
    messages: [],
    metadata: {
      ...metadata,
      type: "projector.runtime-completion",
      runtimeInstanceId,
      activationId,
      completionReason,
    } satisfies RuntimeCompletionFrameMetadata & Record<string, unknown>,
  };
}

export function isRuntimeCompletionFrame(
  frame: Pick<Frame, "metadata"> & Partial<Pick<Frame, "messages">>,
): boolean {
  return readCompletionMetadata(frame, undefined) !== undefined;
}

export function createActivationFrame<
  TDataContent = never,
>({
  activationId,
  runtimeInstanceId,
  generatorId,
  sourceFrameId,
  concurrencyKey,
  concurrency,
}: {
  activationId: string;
  runtimeInstanceId: RuntimeInstanceId;
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
        runtimeInstanceId,
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
  sourceFrameId,
  reason,
}: {
  activationId: string;
  sourceFrameId?: string;
  reason: WorkCompletionReason;
}): FrameDraft<TDataContent> {
  return {
    messages: [
      ({
        type: "work",
        kind: "completion",
        activationId,
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
    typeof record.runtimeInstanceId === "string" &&
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
  const index = lastCompletionIndex(ctx.history, ctx.runtimeInstanceId);
  return actorMessagesFromFrames<TDataContent>(index === -1 ? ctx.history : ctx.history.slice(index + 1));
}

export function messagesBeforeLastCompletion<
  TDataContent = never,
>(
  ctx: HistoryProjectionContext<TDataContent>,
): ActorMessage<TDataContent>[] {
  const index = lastCompletionIndex(ctx.history, ctx.runtimeInstanceId);
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
  runtimeInstanceId: RuntimeInstanceId,
): number {
  const activationRuntimeIds = new Map<string, RuntimeInstanceId>();
  let lastIndex = -1;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!frame) continue;
    if (readCompletionMetadata(frame, runtimeInstanceId)) {
      lastIndex = index;
    }
    for (const message of frame.messages) {
      if (isWorkActivationMessage(message)) {
        activationRuntimeIds.set(message.activationId, message.runtimeInstanceId);
      }
      if (
        isWorkCompletionMessage(message) &&
        activationRuntimeIds.get(message.activationId) === runtimeInstanceId
      ) {
        lastIndex = index;
      }
    }
  }
  return lastIndex;
}

function readCompletionMetadata(
  frame: Pick<Frame<any>, "metadata"> | undefined,
  runtimeInstanceId: RuntimeInstanceId | undefined,
): RuntimeCompletionFrameMetadata | undefined {
  const metadata = frame?.metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const record = metadata as Record<string, unknown>;
  if (record.type !== "projector.runtime-completion") {
    return undefined;
  }
  if (
    runtimeInstanceId !== undefined &&
    record.runtimeInstanceId !== runtimeInstanceId
  ) {
    return undefined;
  }
  if (
    typeof record.runtimeInstanceId !== "string" ||
    typeof record.activationId !== "string" ||
    !isCompletionReason(record.completionReason)
  ) {
    return undefined;
  }

  return {
    type: "projector.runtime-completion",
    runtimeInstanceId: record.runtimeInstanceId,
    activationId: record.activationId,
    completionReason: record.completionReason,
  };
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
  if (record.type === "tool" && typeof record.name === "string") {
    return [{ ...record, type: "tool", name: record.name } as ActorMessage<TDataContent>];
  }

  return [];
}

function isCompletionReason(value: unknown): value is CompletionReason {
  return value === "done" || value === "cancelled" || value === "delegated" || value === "error";
}

function isWorkCompletionReason(value: unknown): value is WorkCompletionReason {
  return value === "end-turn" || value === "done" || value === "cancelled" || value === "delegated";
}
