import { isWorkActivationMessage } from "./history.ts";
import { encodeRuntimeAddress } from "./runtime-address.ts";
import type {
  ActorMessage,
  AnyActorMessage,
  Audience,
  AudienceTarget,
  Frame,
  Generator,
  GeneratorId,
  PrimaryRuntime,
  RuntimeInstanceId,
  WorkerRuntime,
} from "./types.ts";

export type ResolveGeneratorRuntimeId = (
  generatorId: GeneratorId,
) => RuntimeInstanceId | undefined;

export type RuntimeVisibilityTarget = {
  runtimeInstanceId: RuntimeInstanceId;
};

export function isActorMessage<TDataContent = never>(
  message: unknown,
): message is ActorMessage<TDataContent> {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  if (record.type === "user" || record.type === "assistant") {
    return true;
  }
  return record.type === "tool" && typeof record.name === "string";
}

export function defaultAudienceForActorMessage(message: AnyActorMessage): Audience {
  return message.type === "user" ? "broadcast" : "self";
}

export function actorMessageVisibleToGenerator<TDataContent>(
  message: ActorMessage<TDataContent>,
  frame: Frame<TDataContent>,
  target: Generator,
): boolean {
  const audience = message.audience ?? defaultAudienceForActorMessage(message);
  if (audience === "broadcast") {
    return true;
  }
  if (audience === "self") {
    return frame.generatorId === target.id;
  }
  return audienceTargets(audience).some((entry) =>
    encodeRuntimeAddress(entry) === target.runtimeInstanceId,
  );
}

export function actorMessageVisibleToRuntime<TDataContent>(
  message: ActorMessage<TDataContent>,
  frame: Frame<TDataContent>,
  target: RuntimeVisibilityTarget,
  resolveGeneratorRuntimeId: ResolveGeneratorRuntimeId,
): boolean {
  const audience = message.audience ?? defaultAudienceForActorMessage(message);
  if (audience === "broadcast") {
    return true;
  }
  if (audience === "self") {
    return Boolean(
      frame.generatorId &&
        resolveGeneratorRuntimeId(frame.generatorId) === target.runtimeInstanceId,
    );
  }
  return audienceTargets(audience).some((entry) =>
    encodeRuntimeAddress(entry) === target.runtimeInstanceId,
  );
}

function audienceTargets(audience: Exclude<Audience, "self" | "broadcast">): AudienceTarget[] {
  return Array.isArray(audience) ? audience : [audience];
}

export function activationFrameIndexFor<TDataContent>(
  frames: readonly Frame<TDataContent>[],
  activationId: string | undefined,
  options: { requireActivationFrame?: boolean } = {},
): number {
  if (activationId === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  if (activationId.length === 0) {
    throw new Error("activationId must be non-empty when provided");
  }

  const index = frames.findIndex((frame) =>
    frame.messages.some((message) => isWorkActivationMessage(message) && message.activationId === activationId),
  );
  if (index !== -1) {
    return index;
  }
  if (options.requireActivationFrame) {
    throw new Error(
      `Frame history for activation "${activationId}" does not include its activation work frame`,
    );
  }
  return Number.POSITIVE_INFINITY;
}

export function actorMessageVisibleByDelivery(
  message: AnyActorMessage,
  frameIndex: number,
  activationFrameIndex: number,
): boolean {
  return message.delivery !== "queued" || frameIndex <= activationFrameIndex;
}

export function actorMessageVisibleByActivationHistory(
  frame: Frame<any>,
  frameIndex: number,
  activationFrameIndex: number,
  runtime: PrimaryRuntime<any> | WorkerRuntime<any>,
  activationId: string | undefined,
): boolean {
  return frameVisibleByActivationHistory(
    frame,
    frameIndex,
    activationFrameIndex,
    runtime,
    activationId,
  );
}

export function frameVisibleByActivationHistory(
  frame: Frame<any>,
  frameIndex: number,
  activationFrameIndex: number,
  runtime: PrimaryRuntime<any> | WorkerRuntime<any>,
  activationId: string | undefined,
): boolean {
  if (runtime.activationHistory !== "snapshot" || activationId === undefined) {
    return true;
  }
  return frameIndex <= activationFrameIndex || frame.activationId === activationId;
}
