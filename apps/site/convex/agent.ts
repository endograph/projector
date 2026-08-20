"use node";

import { openai } from "@ai-sdk/openai";
import { getAuthUserId } from "@convex-dev/auth/server";
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
  COMMENTARY_ACTION_NAME,
  GET_SURFACE_SOURCE_ACTION_NAME,
  READ_SESSION_ARTIFACTS_ACTION_NAME,
  READ_SESSION_MESSAGES_ACTION_NAME,
  hydrateSiteInstance,
  readCardData,
  siteCharter,
} from "../src/agent/charter";
import { escapeConvexJson, restoreConvexJson } from "./convexJson";

const MODEL_ID = process.env.OPENAI_MODEL ?? "gpt-5.6-sol";

export const sendMessage = action({
  args: {
    sessionId: v.id("sessions"),
    text: v.string(),
    guestSecret: v.optional(v.string()),
  },
  returns: v.object({ success: v.literal(true) }),
  handler: async (ctx, { sessionId, text, guestSecret }): Promise<{ success: true }> => {
    if (!(await getAuthUserId(ctx))) throw new Error("AUTH_REQUIRED");
    await ctx.runMutation(internal.sessions.authorizeAuthenticatedTurn, {
      sessionId,
      guestSecret,
    });
    await runUserMessage(ctx, sessionId, text);
    return { success: true };
  },
});

export const sendAnonymousMessage = internalAction({
  args: {
    sessionId: v.id("sessions"),
    text: v.string(),
  },
  returns: v.object({ success: v.literal(true) }),
  handler: async (ctx, { sessionId, text }): Promise<{ success: true }> => {
    await runUserMessage(ctx, sessionId, text);
    return { success: true };
  },
});

async function runUserMessage(
  ctx: ActionCtx,
  sessionId: Id<"sessions">,
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Message requires text");

  const { machine, referenceFrameId, streamWrites } = await loadAgentMachine(ctx, sessionId);

  // The user row is written before the run so it sorts ahead of the
  // assistant's streaming rows (createdAt is the thread order). The frame
  // persistence pass later finds it by the same idempotency key — derived
  // from this messageId — and patches on the real frameId.
  const userMessageId = crypto.randomUUID();
  await ctx.runMutation(internal.messages.add, {
    sessionId,
    role: "user",
    content: trimmed,
    idempotencyKey: `user:${userMessageId}`,
  });

  machine.enqueueFrame({
    messages: [{ type: "user", text: trimmed, messageId: userMessageId }],
  });

  await runAndPersistAgent(ctx, {
    sessionId,
    machine,
    referenceFrameId,
    streamWrites,
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
      const { machine, referenceFrameId, streamWrites } = await loadAgentMachine(ctx, sessionId);
      await runAndPersistAgent(ctx, {
        sessionId,
        machine,
        referenceFrameId,
        streamWrites,
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
  const streamWrites: Promise<void>[] = [];
  const machine = createMachine({
    id: sessionId,
    instance,
    charter: siteCharter,
    executor: createExecutor(ctx, sessionId, streamWrites),
    frames: contextFrames,
  });
  return { machine, referenceFrameId: session.frameId, streamWrites };
}

async function runAndPersistAgent(
  ctx: ActionCtx,
  {
    sessionId,
    machine,
    referenceFrameId,
    streamWrites,
  }: {
    sessionId: Id<"sessions">;
    machine: Machine;
    referenceFrameId: Id<"frames">;
    streamWrites: Promise<void>[];
  },
): Promise<void> {
  const producedFrames: Frame[] = [];
  for await (const frame of runMachine(machine)) {
    producedFrames.push(frame);
  }
  await Promise.resolve();
  await Promise.allSettled(streamWrites);

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
  streamWrites: Promise<void>[],
) {
  // Stream writes chain sequentially: concurrent patches to the same message
  // row just make the mutation retry loop (OCC conflicts) — the streamSeq
  // guard keeps them safe, but serial is both safe and quiet.
  let lastWrite: Promise<void> = Promise.resolve();
  return new AiSdkExecutor({
    model: openai(MODEL_ID),
    maxOutputTokens: 4096,
    stream: true,
    runAction: async ({ action, input, context, aiSdkContext }) => {
      if (action.name === COMMENTARY_ACTION_NAME) {
        const message = readStringField(input, "message")?.trim();
        if (!message) throw new Error("sendCommentary requires a message");
        const toolCallId = readStringField(aiSdkContext, "toolCallId") ?? crypto.randomUUID();
        await ctx.runMutation(internal.messages.add, {
          sessionId,
          role: "assistant",
          content: message,
          idempotencyKey: assistantStreamKey(toolCallId),
        });
        return actionResult({
          value: "commentary sent",
          messages: [
            {
              type: "assistant",
              text: message,
              audience: "broadcast",
              messageId: toolCallId,
            } as FrameMessage,
          ],
        });
      }
      // The surface's TSX lives in the artifacts table, not machine state, so
      // retrieval is an executor concern: read the latest artifact here.
      if (action.name === GET_SURFACE_SOURCE_ACTION_NAME) {
        const surface: { version: number; title: string; source: string } | null =
          await ctx.runQuery(internal.artifacts.latestSurfaceSource, { sessionId });
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
      lastWrite = lastWrite
        .catch(() => {})
        .then(() => persistStreamUpdate(ctx, sessionId, update));
      streamWrites.push(lastWrite);
      return lastWrite;
    },
  });
}

function requireSessionId(input: unknown): Id<"sessions"> {
  const sessionId = readStringField(input, "sessionId")?.trim();
  if (!sessionId) throw new Error("sessionId is required");
  return sessionId as Id<"sessions">;
}

async function persistStreamUpdate(
  ctx: ActionCtx,
  sessionId: Id<"sessions">,
  update: AiSdkStreamUpdate,
): Promise<void> {
  // The executor announces a stream before it has text. Do not create the
  // final-response row yet: commentary tools may run first, and message
  // creation time is the transcript order.
  if (update.streamState !== "streaming" || update.text.length === 0) return;
  await ctx.runMutation(internal.messages.add, {
    sessionId,
    role: "assistant",
    content: update.text,
    idempotencyKey: assistantStreamKey(update.messageId),
    streamState: "streaming",
    streamSeq: update.streamSeq,
  });
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
      await ctx.runMutation(internal.messages.add, {
        sessionId,
        role: "user",
        content: text,
        frameId,
        idempotencyKey: frameMessageKey("user", frame, message, messageIndex),
      });
    }

    if (
      message.type === "assistant" &&
      shouldPersistAssistantMessage(frame, message) &&
      text.trim()
    ) {
      const streamSeq = readNumberField(message, "streamSeq");
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
        ...(streamSeq !== undefined ? { streamSeq } : {}),
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

function readNumberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}
