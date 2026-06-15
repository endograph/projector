import type {
  ActorMessage,
  CompletionReason,
  Frame,
  FrameDraft,
  GeneratorId,
  HistoryProjectionContext,
  RuntimeConcurrency,
  RuntimeInstanceId,
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

export function createRuntimeCompletionFrame({
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
}): FrameDraft {
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

export function createActivationFrame({
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
}): FrameDraft {
  return {
    messages: [
      {
        type: "work",
        kind: "activation",
        activationId,
        runtimeInstanceId,
        generatorId,
        sourceFrameId,
        concurrencyKey,
        concurrency,
      } satisfies WorkActivationMessage,
    ],
  };
}

export function createCompletionFrame({
  activationId,
  sourceFrameId,
  reason,
}: {
  activationId: string;
  sourceFrameId?: string;
  reason: WorkCompletionReason;
}): FrameDraft {
  return {
    messages: [
      {
        type: "work",
        kind: "completion",
        activationId,
        ...(sourceFrameId !== undefined ? { sourceFrameId } : {}),
        reason,
      } satisfies WorkCompletionMessage,
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

export function actorMessages(ctx: HistoryProjectionContext): ActorMessage[] {
  return actorMessagesFromFrames(ctx.history);
}

export function messagesSinceLastCompletion(
  ctx: HistoryProjectionContext,
): ActorMessage[] {
  const index = lastCompletionIndex(ctx.history, ctx.runtimeInstanceId);
  return actorMessagesFromFrames(index === -1 ? ctx.history : ctx.history.slice(index + 1));
}

export function messagesBeforeLastCompletion(
  ctx: HistoryProjectionContext,
): ActorMessage[] {
  const index = lastCompletionIndex(ctx.history, ctx.runtimeInstanceId);
  return index === -1 ? [] : actorMessagesFromFrames(ctx.history.slice(0, index));
}

export function actorMessagesFromFrames(frames: readonly Frame[]): ActorMessage[] {
  return frames.flatMap((frame) => frame.messages.flatMap(actorMessageFromUnknown));
}

function lastCompletionIndex(
  frames: readonly Frame[],
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
  frame: Pick<Frame, "metadata"> | undefined,
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

function actorMessageFromUnknown(value: unknown): ActorMessage[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  if (record.type === "user" && typeof record.text === "string") {
    return [{ ...record, type: "user", text: record.text } as ActorMessage];
  }
  if (record.type === "assistant" && typeof record.text === "string") {
    return [{ ...record, type: "assistant", text: record.text } as ActorMessage];
  }
  if (record.type === "tool" && typeof record.name === "string") {
    return [{ ...record, type: "tool", name: record.name } as ActorMessage];
  }

  return [];
}

function isCompletionReason(value: unknown): value is CompletionReason {
  return value === "done" || value === "cancelled" || value === "delegated" || value === "error";
}

function isWorkCompletionReason(value: unknown): value is WorkCompletionReason {
  return value === "end-turn" || value === "done" || value === "cancelled" || value === "delegated";
}
