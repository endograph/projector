import { isWorkActivationMessage } from "./history.ts";
import { encodeProjectionAddress } from "./projection-address.ts";
import type {
  ActorMessage,
  AnyActorMessage,
  Audience,
  AudienceTarget,
  Frame,
  GeneratorId,
  GeneratorRuntime,
} from "./types.ts";

export type GeneratorVisibilityTarget = {
  generatorId: GeneratorId;
};

export function isActorMessage<TDataContent = never>(
  message: unknown,
): message is ActorMessage<TDataContent> {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  if (record.type === "user" || record.type === "assistant") {
    return true;
  }
  return false;
}

export function defaultAudienceForActorMessage(message: AnyActorMessage): Audience {
  return message.type === "user" ? "broadcast" : "self";
}

export function actorMessageVisibleToGenerator<TDataContent>(
  message: ActorMessage<TDataContent>,
  frame: Frame<TDataContent>,
  targetGeneratorId: GeneratorId,
): boolean {
  const audience = message.audience ?? defaultAudienceForActorMessage(message);
  if (audience === "broadcast") {
    return true;
  }
  if (audience === "self") {
    return frame.generatorId === targetGeneratorId;
  }
  return audienceTargets(audience).some((entry) =>
    encodeProjectionAddress(entry) === targetGeneratorId,
  );
}

export function actorMessageVisibleToGeneratorId<TDataContent>(
  message: ActorMessage<TDataContent>,
  frame: Frame<TDataContent>,
  target: GeneratorVisibilityTarget,
): boolean {
  const audience = message.audience ?? defaultAudienceForActorMessage(message);
  if (audience === "broadcast") {
    return true;
  }
  if (audience === "self") {
    return frame.generatorId === target.generatorId;
  }
  return audienceTargets(audience).some((entry) =>
    encodeProjectionAddress(entry) === target.generatorId,
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
  runtime: GeneratorRuntime<any>,
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
  runtime: GeneratorRuntime<any>,
  activationId: string | undefined,
): boolean {
  if (runtime.activationHistory !== "snapshot" || activationId === undefined) {
    return true;
  }
  return frameIndex <= activationFrameIndex || frame.activationId === activationId;
}
