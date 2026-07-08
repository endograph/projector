import { isWorkActivationMessage } from "./history.ts";
import { encodeProjectionAddress } from "./projection-address.ts";
import type {
  ActionMessage,
  ActorMessage,
  AnyActorMessage,
  Audience,
  AudienceTarget,
  Frame,
  GeneratorId,
  GeneratorRuntime,
} from "./types.ts";

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

export function isActionMessage<TDataContent = never>(
  message: unknown,
): message is ActionMessage<TDataContent> {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "action",
  );
}

export function defaultAudienceForActorMessage(message: AnyActorMessage): Audience {
  return message.type === "user" ? "broadcast" : "self";
}

/**
 * An activation's action traffic is private to its generator by default;
 * action frames without a producing generator (e.g. app-issued commands)
 * default to broadcast, like user messages.
 */
export function defaultAudienceForActionMessage(frame: Frame<any>): Audience {
  return frame.generatorId ? "self" : "broadcast";
}

export function audienceAllowsGenerator(
  audience: Audience,
  frame: Frame<any>,
  targetGeneratorId: GeneratorId,
): boolean {
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

export function actorMessageVisibleToGenerator<TDataContent>(
  message: ActorMessage<TDataContent>,
  frame: Frame<TDataContent>,
  targetGeneratorId: GeneratorId,
): boolean {
  const audience = message.audience ?? defaultAudienceForActorMessage(message);
  return audienceAllowsGenerator(audience, frame, targetGeneratorId);
}

export function actionMessageVisibleToGenerator<TDataContent>(
  message: ActionMessage<TDataContent>,
  frame: Frame<TDataContent>,
  targetGeneratorId: GeneratorId,
): boolean {
  const audience = message.audience ?? defaultAudienceForActionMessage(frame);
  return audienceAllowsGenerator(audience, frame, targetGeneratorId);
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

/**
 * Applies all history visibility rules (activation history, audience, delivery)
 * and returns the frames a generator activation can see, each narrowed to its
 * visible messages. This is the single source of truth shared by projection
 * compilation and work absorption.
 */
export function visibleFramesForGenerator<TDataContent>(
  frames: readonly Frame<TDataContent>[],
  targetGeneratorId: GeneratorId,
  runtime: GeneratorRuntime,
  activationId?: string,
): Frame<TDataContent>[] {
  const activationFrameIndex = activationFrameIndexFor(frames, activationId, {
    requireActivationFrame: activationId !== undefined,
  });

  return frames.flatMap((frame, frameIndex) => {
    if (!frameVisibleByActivationHistory(
      frame,
      frameIndex,
      activationFrameIndex,
      runtime,
      activationId,
    )) {
      return [];
    }

    const frameMessages = frame.messages.filter((message) => {
      if (isActorMessage(message)) {
        return (
          actorMessageVisibleToGenerator(message, frame, targetGeneratorId) &&
          actorMessageVisibleByDelivery(message, frameIndex, activationFrameIndex)
        );
      }
      if (isActionMessage(message)) {
        return actionMessageVisibleToGenerator(message, frame, targetGeneratorId);
      }
      return true;
    });

    return frameMessages.length > 0 ? [{ ...frame, messages: frameMessages }] : [];
  });
}

export function frameVisibleByActivationHistory(
  frame: Frame<any>,
  frameIndex: number,
  activationFrameIndex: number,
  runtime: GeneratorRuntime,
  activationId: string | undefined,
): boolean {
  if (runtime.activationHistory !== "snapshot" || activationId === undefined) {
    return true;
  }
  return frameIndex <= activationFrameIndex || frame.activationId === activationId;
}
