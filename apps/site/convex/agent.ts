"use node";

import { openai } from "@ai-sdk/openai";
import { AiSdkExecutor, type AiSdkStreamUpdate } from "@projectors/aisdk-executor";
import {
  ROOT_GENERATOR_ID,
  actionResult,
  createMachine,
  runMachine,
  type Frame,
  type FrameMessage,
  type Machine,
  type SerializedInstance,
} from "@projectors/core";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  GET_SURFACE_SOURCE_ACTION_NAME,
  READ_SESSION_ARTIFACTS_ACTION_NAME,
  READ_SESSION_MESSAGES_ACTION_NAME,
  hydrateSiteInstance,
  readCardData,
  siteCharter,
} from "../src/agent/charter";
import { anonymousActor } from "./actors";
import { requireClientMessageId, type MessageActor } from "./messageActor";
import { escapeConvexJson, restoreConvexJson } from "./convexJson";
import { SITE_MODEL_ID, sitePromptExecutorConfig } from "./executorConfig";

const STREAM_WRITE_INTERVAL_MS = 250;

export const sendMessage = action({
  args: {
    sessionId: v.id("sessions"),
    text: v.string(),
    clientMessageId: v.string(),
    guestSecret: v.optional(v.string()),
  },
  returns: v.object({ success: v.literal(true) }),
  handler: async (
    ctx,
    { sessionId, text, clientMessageId, guestSecret },
  ): Promise<{ success: true }> => {
    const actor = await ctx.runMutation(internal.sessions.authorizeAuthenticatedTurn, {
      sessionId,
      guestSecret,
    });
    await runUserMessage(ctx, sessionId, text, clientMessageId, actor);
    return { success: true };
  },
});

export const sendAnonymousMessage = internalAction({
  args: {
    sessionId: v.id("sessions"),
    text: v.string(),
    clientMessageId: v.string(),
  },
  returns: v.object({ success: v.literal(true) }),
  handler: async (
    ctx,
    { sessionId, text, clientMessageId },
  ): Promise<{ success: true }> => {
    await runUserMessage(ctx, sessionId, text, clientMessageId, anonymousActor(sessionId));
    return { success: true };
  },
});

async function runUserMessage(
  ctx: ActionCtx,
  sessionId: Id<"sessions">,
  text: string,
  clientMessageId: string,
  actor: MessageActor,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Message requires text");
  const normalizedClientMessageId = requireClientMessageId(clientMessageId);

  const { machine, referenceFrameId, streamWriter } = await loadAgentMachine(ctx, sessionId);

  // The user row is written before the run so it sorts ahead of the
  // assistant's streaming rows (createdAt is the thread order). The frame
  // persistence pass later finds it by the same idempotency key — derived
  // from this messageId — and patches on the real frameId.
  // The client id only reconciles the optimistic UI row. Persistence gets a
  // fresh server identity, so retrying a request is plainly a second turn.
  const userMessageId = crypto.randomUUID();
  await ctx.runMutation(internal.messages.add, {
    sessionId,
    role: "user",
    content: trimmed,
    actor,
    clientMessageId: normalizedClientMessageId,
    idempotencyKey: `user:${userMessageId}`,
  });

  machine.enqueueFrame({
    messages: [
      {
        type: "user",
        text: trimmed,
        actor,
        clientMessageId: normalizedClientMessageId,
        messageId: userMessageId,
      },
    ],
  });

  await runAndPersistAgent(ctx, {
    sessionId,
    machine,
    referenceFrameId,
    streamWriter,
  });
}

// appPanePing's command frame is committed transactionally first. That frame
// already contains the durable actor stimulus and scheduler activation; this
// action simply reloads the session and drains pending work through the same
// path as a typed chat turn.
export const continueAfterCommand = internalAction({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    try {
      const { machine, referenceFrameId, streamWriter } = await loadAgentMachine(ctx, sessionId);
      await runAndPersistAgent(ctx, {
        sessionId,
        machine,
        referenceFrameId,
        streamWriter,
      });
    } finally {
      // The frame-persist mutation clears workStartedAt transactionally; this
      // covers runs that crash or produce no frames so the thinking indicator
      // can't stay lit.
      await ctx.runMutation(internal.sessions.clearWork, { sessionId });
    }
    return null;
  },
});

async function loadAgentMachine(ctx: ActionCtx, sessionId: Id<"sessions">) {
  const session = await ctx.runQuery(internal.sessions.getForAction, { sessionId });
  if (!session) {
    throw new Error("Session not found");
  }

  // Both payloads cross Convex return boundaries escaped (spawned children
  // put JSON Schema $-keys inside serialized instances and spawn frames).
  const instance = hydrateSiteInstance(
    restoreConvexJson(session.instance) as SerializedInstance,
    sessionId,
  );
  const contextFrames = restoreConvexJson(
    await ctx.runQuery(internal.sessions.listMachineContextFrames, { sessionId }),
  ) as Frame[];
  const streamWriter = createStreamWriter(ctx, sessionId);
  const machine = createMachine({
    id: sessionId,
    instance,
    charter: siteCharter,
    executor: createExecutor(ctx, sessionId, streamWriter),
    frames: contextFrames,
  });
  return { machine, referenceFrameId: session.frameId, streamWriter };
}

async function runAndPersistAgent(
  ctx: ActionCtx,
  {
    sessionId,
    machine,
    referenceFrameId,
    streamWriter,
  }: {
    sessionId: Id<"sessions">;
    machine: Machine;
    referenceFrameId: Id<"frames">;
    streamWriter: StreamWriter;
  },
): Promise<void> {
  const producedFrames: Frame[] = [];
  try {
    for await (const frame of runMachine(machine)) {
      producedFrames.push(frame);
    }
  } finally {
    // The executor reports stream failures out-of-band too. Always drain its
    // final delta or terminal marker, even when model/tool execution throws.
    await streamWriter.flush();
  }

  if (producedFrames.length === 0) return;

  const frameIds = await ctx.runMutation(internal.sessions.appendMachineFrameSequence, {
    sessionId,
    referenceFrameId,
    frames: escapeConvexJson(producedFrames),
  });

  // A successful writeAppSurface anywhere in the turn stamps the turn's
  // last assistant message, so the transcript can offer "open the app pane"
  // at the end of the response.
  const surfaceUpdated = producedFrames.some((frame) =>
    frame.messages.some(
      (message) =>
        message.type === "action" &&
        message.kind === "result" &&
        message.name === "writeAppSurface" &&
        message.success,
    ),
  );
  const lastAssistant = surfaceUpdated ? findLastAssistantMessage(producedFrames) : null;

  for (const [index, frame] of producedFrames.entries()) {
    const frameId = frameIds[index];
    if (!frameId) continue;
    await persistFrameMessages(ctx, {
      sessionId,
      frame,
      frameId,
      updatedSurfaceMessageIndex:
        lastAssistant?.frameIndex === index ? lastAssistant.messageIndex : undefined,
    });
  }
}

function createExecutor(
  ctx: ActionCtx,
  sessionId: Id<"sessions">,
  streamWriter: StreamWriter,
) {
  return new AiSdkExecutor({
    ...sitePromptExecutorConfig(openai(SITE_MODEL_ID)),
    stream: true,
    runAction: async ({ action, input, context }) => {
      // The surface's TSX lives in the artifacts table, not machine state, so
      // retrieval is an executor concern: read the latest artifact here.
      if (action.name === GET_SURFACE_SOURCE_ACTION_NAME) {
        const surface: { version: number; title: string; source: string } | null =
          await ctx.runQuery(internal.artifacts.activeSurfaceSource, { sessionId });
        return actionResult({
          value: surface
            ? `app surface v${surface.version} "${surface.title}":\n\n${surface.source}`
            : "no app surface has been written yet",
        });
      }
      if (action.name === READ_SESSION_MESSAGES_ACTION_NAME) {
        const targetSessionId = requireSessionId(input);
        const result = await ctx.runQuery(internal.messages.pageForAgent, {
          sessionId: targetSessionId,
          paginationOpts: {
            numItems: 10,
            cursor: readStringField(input, "cursor") ?? null,
          },
        });
        return actionResult({ value: JSON.stringify(result) });
      }
      if (action.name === READ_SESSION_ARTIFACTS_ACTION_NAME) {
        const targetSessionId = requireSessionId(input);
        const result = await ctx.runQuery(internal.artifacts.pageForAgent, {
          sessionId: targetSessionId,
          paginationOpts: {
            numItems: 10,
            cursor: readStringField(input, "cursor") ?? null,
          },
        });
        return actionResult({ value: JSON.stringify(result) });
      }
      return await action.run?.(input as never, context as never);
    },
    onStreamUpdate: (update) => {
      streamWriter.push(update);
    },
  });
}

type StreamWriter = {
  push: (update: AiSdkStreamUpdate) => void;
  flush: () => Promise<void>;
};

function createStreamWriter(
  ctx: ActionCtx,
  sessionId: Id<"sessions">,
): StreamWriter {
  // Keep only the latest pending snapshot for each assistant block and cap
  // durable updates at a still-smooth 4 fps. Each successful write appends
  // only the text since the prior write; coalesced provider chunks therefore
  // become one small immutable delta rather than a cumulative message rewrite.
  const pending = new Map<string, AiSdkStreamUpdate>();
  const persistedText = new Map<string, string>();
  const terminals = new Map<string, "cancelled" | "error">();
  const failed = new Set<string>();
  let lastWriteAt = 0;
  // One serialization mechanism: every push chains a drain onto this tail.
  // drainAll never rejects (both mutation calls are individually guarded),
  // so the chain cannot wedge on an earlier failure.
  let tail: Promise<void> = Promise.resolve();

  const drainAll = async (): Promise<void> => {
    while (pending.size > 0 || terminals.size > 0) {
      const next = pending.entries().next().value as
        | [string, AiSdkStreamUpdate]
        | undefined;
      if (next) {
        const [messageId, update] = next;
        pending.delete(messageId);
        if (!failed.has(messageId)) {
          const previous = persistedText.get(messageId) ?? "";
          const delta = update.text.startsWith(previous)
            ? update.text.slice(previous.length)
            : update.text;
          if (delta) {
            const waitMs = STREAM_WRITE_INTERVAL_MS - (Date.now() - lastWriteAt);
            if (waitMs > 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
            }
            try {
              await ctx.runMutation(internal.messages.appendStreamDelta, {
                sessionId,
                messageKey: assistantStreamKey(messageId),
                text: delta,
                streamSeq: update.streamSeq,
              });
              persistedText.set(messageId, update.text);
              lastWriteAt = Date.now();
            } catch {
              failed.add(messageId);
              terminals.set(messageId, "error");
            }
          }
        }
        continue;
      }

      const terminal = terminals.entries().next().value as
        | [string, "cancelled" | "error"]
        | undefined;
      if (!terminal) break;
      const [messageId, state] = terminal;
      terminals.delete(messageId);
      await ctx.runMutation(internal.messages.markStreamFailed, {
        sessionId,
        messageKey: assistantStreamKey(messageId),
        state,
      }).catch(() => {});
    }
  };

  return {
    push(update) {
      if (update.streamState === "streaming" && update.text.length > 0) {
        pending.set(update.messageId, update);
      }
      if (update.streamState === "cancelled" || update.streamState === "error") {
        terminals.set(update.messageId, update.streamState);
      }
      if (pending.size === 0 && terminals.size === 0) return;
      tail = tail.then(drainAll);
    },
    async flush() {
      // Stream callbacks are deliberately out-of-band in the executor. Let
      // the final callback enter this writer, then await the tail — looping
      // in case a straggler push lands while an earlier drain settles.
      await Promise.resolve();
      let settled: Promise<void>;
      do {
        settled = tail;
        await settled;
      } while (settled !== tail);
    },
  };
}

function requireSessionId(input: unknown): Id<"sessions"> {
  const sessionId = readStringField(input, "sessionId")?.trim();
  if (!sessionId) throw new Error("sessionId is required");
  return sessionId as Id<"sessions">;
}

function findLastAssistantMessage(
  frames: Frame[],
): { frameIndex: number; messageIndex: number } | null {
  let last: { frameIndex: number; messageIndex: number } | null = null;
  for (const [frameIndex, frame] of frames.entries()) {
    for (const [messageIndex, message] of frame.messages.entries()) {
      const text = typeof message.text === "string" ? message.text : "";
      if (message.type === "assistant" && shouldPersistAssistantMessage(frame, message) && text.trim()) {
        last = { frameIndex, messageIndex };
      }
    }
  }
  return last;
}

async function persistFrameMessages(
  ctx: ActionCtx,
  {
    sessionId,
    frame,
    frameId,
    updatedSurfaceMessageIndex,
  }: {
    sessionId: Id<"sessions">;
    frame: Frame;
    frameId: Id<"frames">;
    updatedSurfaceMessageIndex?: number;
  },
): Promise<void> {
  for (const [messageIndex, message] of frame.messages.entries()) {
    const text = typeof message.text === "string" ? message.text : "";
    if (message.type === "user" && text.trim()) {
      const actor = readMessageActor(message);
      const clientMessageId = readStringField(message, "clientMessageId");
      await ctx.runMutation(internal.messages.add, {
        sessionId,
        role: "user",
        content: text,
        frameId,
        ...(actor ? { actor } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        idempotencyKey: frameMessageKey("user", frame, message, messageIndex),
      });
    }

    if (
      message.type === "assistant" &&
      shouldPersistAssistantMessage(frame, message) &&
      text.trim()
    ) {
      // postCard rides an assistant message as a data content part; lift it
      // onto the message row so the transcript renders the card (content
      // stays the prose equivalent, same doctrine as explainer widgets).
      const card = readCardData(message);
      await ctx.runMutation(internal.messages.add, {
        sessionId,
        role: "assistant",
        content: text,
        frameId,
        ...(card ? { card: { title: card.title, source: card.source } } : {}),
        ...(messageIndex === updatedSurfaceMessageIndex ? { updatedSurface: true } : {}),
        idempotencyKey: frameMessageKey("assistant", frame, message, messageIndex),
        // The durable write settles any in-flight stream row for this message:
        // frame messages never carry streamState, so it must be set here or a
        // streamed message stays "streaming" forever.
        streamState: "complete",
      });
    }
  }
}

function shouldPersistAssistantMessage(frame: Frame, message: FrameMessage): boolean {
  if (message.audience === "self") return false;
  return frame.generatorId === undefined || frame.generatorId === ROOT_GENERATOR_ID;
}

function frameMessageKey(
  prefix: "user" | "assistant",
  frame: Frame,
  message: FrameMessage,
  messageIndex: number,
): string {
  const messageId = readStringField(message, "messageId");
  if (messageId && prefix === "assistant") return assistantStreamKey(messageId);
  if (messageId) return `${prefix}:${messageId}`;
  return `${prefix}:${frame.id}:${messageIndex}`;
}

function assistantStreamKey(messageId: string): string {
  return `assistant:${messageId}`;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}


function readMessageActor(message: FrameMessage): MessageActor | undefined {
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
