import { isWorkActivationMessage } from "./history.ts";
import { encodeRuntimeAddress } from "./runtime-address.ts";
import type {
  ActorMessage,
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

export function isActorMessage(message: unknown): message is ActorMessage {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  if (record.type === "user" || record.type === "assistant") {
    return typeof record.text === "string";
  }
  return record.type === "tool" && typeof record.name === "string";
}

export function defaultAudienceForActorMessage(message: ActorMessage): Audience {
  return message.type === "user" ? "broadcast" : "self";
}

export function actorMessageVisibleToGenerator(
  message: ActorMessage,
  frame: Frame,
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

export function actorMessageVisibleToRuntime(
  message: ActorMessage,
  frame: Frame,
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

export function activationFrameIndexFor(
  frames: readonly Frame[],
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
  message: ActorMessage,
  frameIndex: number,
  activationFrameIndex: number,
): boolean {
  return message.delivery !== "queued" || frameIndex <= activationFrameIndex;
}

export function actorMessageVisibleByActivationHistory(
  frame: Frame,
  frameIndex: number,
  activationFrameIndex: number,
  runtime: PrimaryRuntime | WorkerRuntime,
  activationId: string | undefined,
): boolean {
  if (runtime.activationHistory !== "snapshot" || activationId === undefined) {
    return true;
  }
  return frameIndex <= activationFrameIndex || frame.activationId === activationId;
}
