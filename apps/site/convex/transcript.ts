// The one definition of how frame messages map to transcript rows: idempotency
// keys, visibility, and actor extraction. The enqueue mutations (inbox,
// topics) write rows with these keys ahead of the frame, and the runner's
// frame-append patches the same rows by exact key match — the format living in
// one module is what keeps that reconciliation from silently breaking.
// Pure helpers only: the node runner imports this, so no registered functions
// and no mutation-bearing imports.

import type { Frame, FrameMessage } from "@projectors/core";
import { ROOT_GENERATOR_ID } from "@projectors/core";
import type { MessageActor } from "./messageActor";
import { isTranscriptVisible } from "../src/agent/transcript-visibility";

export { isTranscriptVisible };

export function userMessageKey(messageId: string): string {
  return `user:${messageId}`;
}

// Also the streaming row's key: the executor's stream writer and the durable
// frame persist must address the same row for the settle-on-persist handoff.
export function assistantMessageKey(messageId: string): string {
  return `assistant:${messageId}`;
}

export function frameMessageKey(
  prefix: "user" | "assistant",
  frame: Frame,
  message: FrameMessage,
  messageIndex: number,
): string {
  const messageId = readStringField(message, "messageId");
  if (messageId && prefix === "assistant") return assistantMessageKey(messageId);
  if (messageId) return userMessageKey(messageId);
  return `${prefix}:${frame.id}:${messageIndex}`;
}

export function shouldPersistAssistantMessage(frame: Frame, message: FrameMessage): boolean {
  if (message.audience === "self") return false;
  return frame.generatorId === undefined || frame.generatorId === ROOT_GENERATOR_ID;
}

export function readMessageActor(message: FrameMessage): MessageActor | undefined {
  const actor = message.actor;
  if (!actor || typeof actor !== "object") return undefined;
  const { id, kind, label, profileUrl } = actor as Record<string, unknown>;
  if (
    typeof id !== "string" ||
    (kind !== "anonymous" && kind !== "github") ||
    typeof label !== "string"
  ) {
    return undefined;
  }
  return {
    id,
    kind,
    label,
    ...(typeof profileUrl === "string" ? { profileUrl } : {}),
  };
}

export function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}
