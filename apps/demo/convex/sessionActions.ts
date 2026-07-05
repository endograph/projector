"use node";

import { action } from "./_generated/server";
import { api } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { openai as aiSdkOpenAI } from "@ai-sdk/openai";
import { AiSdkExecutor } from "@projectors/aisdk-executor";
import {
  ROOT_GENERATOR_ID,
  createMachine,
  executeCommand,
  runMachine,
  type Executor,
  type Frame,
} from "@projectors/core";
import {
  attachmentSummary,
  attachmentValidator,
  resolveAttachmentUrls,
  storedAttachmentsFromContentParts,
  userContentPartsForFrame,
} from "./attachments";
import type { DemoAttachmentData } from "@projectors/demo-agent/src/attachments.js";
import { escapeConvexJson } from "./convexJson";
import {
  createInitialSerializedInstance,
  createDemoCharter,
  hydrateDemoInstance,
} from "@projectors/demo-agent/src/projector-demo.js";
import type { ClientMachineMessage } from "@projectors/core/client";

const DISCRETE_MODEL = process.env.OPENAI_DISCRETE_MODEL ?? "gpt-5.5";

const discreteExecutor = new AiSdkExecutor<DemoAttachmentData>({
  model: aiSdkOpenAI(DISCRETE_MODEL),
  maxOutputTokens: 4096,
});

export const createSession = action({
  args: {},
  handler: async (ctx): Promise<Id<"sessions">> => {
    const instance = createInitialSerializedInstance();
    return await ctx.runMutation(api.sessions.create, {
      instanceId: instance.id,
      instance: escapeConvexJson(instance),
      syncState: escapeConvexJson({ recentCommandResidue: [] }),
    });
  },
});

export const sendMessage = action({
  args: {
    sessionId: v.id("sessions"),
    content: v.string(),
    attachments: v.optional(v.array(attachmentValidator)),
  },
  handler: async (ctx, { sessionId, content, attachments }): Promise<{ success: true }> => {
    const session = await ctx.runQuery(api.sessions.get, { id: sessionId });
    if (!session) {
      throw new Error("Session not found");
    }

    const rootInstance = hydrateDemoInstance(session.instance, sessionId);
    const contextFrames = (await ctx.runQuery(api.sessions.listMachineContextFrames, { sessionId })) as Frame<DemoAttachmentData>[];
    const memoryExecutor = new AiSdkExecutor<DemoAttachmentData>({
      model: aiSdkOpenAI(DISCRETE_MODEL),
      maxOutputTokens: 1024,
      maxSteps: 3,
    });
    const isMemoryRequest = (request: { inference: { tools: Array<{ name: string }> } }) =>
      request.inference.tools.some((tool) => tool.name === "saveMemories");
    const executor: Executor<DemoAttachmentData> = {
      run: (request) =>
        isMemoryRequest(request)
          ? memoryExecutor.run(request)
          : discreteExecutor.run(request),
      realizePrompt: (request) =>
        isMemoryRequest(request)
          ? memoryExecutor.realizePrompt(request)
          : discreteExecutor.realizePrompt(request),
    };
    const machine = createMachine<DemoAttachmentData>({
      id: sessionId,
      instance: rootInstance,
      charter: createDemoCharter(),
      executor,
      frames: contextFrames,
    });

    const storedAttachments = attachments ?? [];
    const resolvedAttachments = (await resolveAttachmentUrls(ctx, storedAttachments)) ?? [];
    const userText = content.trim() || (storedAttachments.length ? attachmentSummary(storedAttachments) : "");
    const userContent = userContentPartsForFrame(content, resolvedAttachments);
    if (!userText || userContent.length === 0) {
      throw new Error("Message requires text or attachments");
    }

    machine.enqueueFrame({
      messages: [{ type: "user", content: userContent, text: userText }],
    });

    const producedFrames: Frame<DemoAttachmentData>[] = [];
    for await (const frame of runMachine(machine)) {
      producedFrames.push(frame);
    }

    const durableFrames = producedFrames.map((frame) =>
      prepareMachineFrame(frame, ROOT_GENERATOR_ID)
    );
    const frameIds = await ctx.runMutation(api.sessions.appendMachineFrameSequence, {
      sessionId,
      referenceFrameId: session.frameId,
      frames: durableFrames,
    }) as Id<"frames">[];

    for (const [index, frame] of durableFrames.entries()) {
      const frameId = frameIds[index];
      if (!frameId) continue;
      await persistFrameMessages(ctx, {
        sessionId,
        frame,
        frameId,
        rootGeneratorId: ROOT_GENERATOR_ID,
      });
    }

    return { success: true };
  },
});

export const sendClientMessage = action({
  args: {
    sessionId: v.id("sessions"),
    message: v.any(),
  },
  handler: async (ctx, { sessionId, message }): Promise<unknown> => {
    const session = await ctx.runQuery(api.sessions.get, { id: sessionId });
    if (!session) {
      throw new Error("Session not found");
    }

    const rootInstance = hydrateDemoInstance(session.instance, sessionId);
    const contextFrames = (await ctx.runQuery(api.sessions.listMachineContextFrames, { sessionId })) as Frame<DemoAttachmentData>[];
    const machine = createMachine<DemoAttachmentData>({
      id: sessionId,
      instance: rootInstance,
      charter: createDemoCharter(),
      frames: contextFrames,
    });
    const command = message as ClientMachineMessage;
    const result = await executeCommand(machine, command);

    const producedFrames: Frame<DemoAttachmentData>[] = [];
    for await (const frame of runMachine(machine, { scheduleWork: false })) {
      producedFrames.push(frame);
    }

    const frameIds = await ctx.runMutation(api.sessions.appendMachineFrameSequence, {
      sessionId,
      referenceFrameId: session.frameId,
      frames: producedFrames,
    }) as Id<"frames">[];
    await persistClientCommandAssistantMessages(ctx, {
      sessionId,
      message: command,
      frames: producedFrames,
      frameIds,
    });
    return result;
  },
});

export const createSessionAtFoo = createSession;

type DurableFrame = Frame<DemoAttachmentData> & { metadata?: Record<string, unknown> };

function prepareMachineFrame(frame: Frame<DemoAttachmentData>, rootGeneratorId: string): DurableFrame {
  const mode =
    frame.generatorId === undefined || frame.generatorId === rootGeneratorId
      ? "text"
      : "memory";
  return {
    ...frame,
    metadata: {
      mode,
      transport: "convex",
    },
  };
}

async function persistFrameMessages(
  ctx: ActionCtx,
  {
    sessionId,
    frame,
    frameId,
    rootGeneratorId,
  }: {
    sessionId: Id<"sessions">;
    frame: Frame<DemoAttachmentData>;
    frameId: Id<"frames">;
    rootGeneratorId: string;
  },
): Promise<void> {
  for (const message of frame.messages) {
    const text = typeof message.text === "string" ? message.text : "";
    if (message.type === "user" && text.trim()) {
      const attachments = storedAttachmentsFromContentParts(message.content);
      await ctx.runMutation(api.messages.add, {
        sessionId,
        role: "user",
        content: text,
        ...(attachments.length ? { attachments } : {}),
        frameId,
        mode: "text",
        idempotencyKey: idempotencyKey("user", message),
      });
    }

    if (
      message.type === "assistant" &&
      shouldPersistAssistantMessage(frame, message, rootGeneratorId) &&
      text.trim()
    ) {
      await ctx.runMutation(api.messages.add, {
        sessionId,
        role: "assistant",
        content: text,
        frameId,
        mode: "text",
        idempotencyKey: idempotencyKey("assistant", message),
      });
    }
  }
}

function shouldPersistAssistantMessage(
  frame: Frame<DemoAttachmentData>,
  message: Frame<DemoAttachmentData>["messages"][number],
  rootGeneratorId: string,
): boolean {
  if (message.audience === "self") return false;
  return frame.generatorId === rootGeneratorId;
}

async function persistClientCommandAssistantMessages(
  ctx: ActionCtx,
  {
    sessionId,
    message,
    frames,
    frameIds,
  }: {
    sessionId: Id<"sessions">;
    message: ClientMachineMessage;
    frames: Frame<DemoAttachmentData>[];
    frameIds: Id<"frames">[];
  },
): Promise<void> {
  for (const [frameIndex, frame] of frames.entries()) {
    const frameId = frameIds[frameIndex];
    if (!frameId) continue;

    for (const [messageIndex, frameMessage] of frame.messages.entries()) {
      if (frameMessage.type !== "assistant") continue;
      const text = typeof frameMessage.text === "string" ? frameMessage.text.trim() : "";
      if (!text) continue;

      await ctx.runMutation(api.messages.add, {
        sessionId,
        role: "assistant",
        content: text,
        frameId,
        mode: "text",
        idempotencyKey: message.callId
          ? `command:${message.callId}:assistant:${frameIndex}:${messageIndex}`
          : undefined,
      });
    }
  }
}

function idempotencyKey(prefix: string, source: unknown): string {
  if (source && typeof source === "object") {
    const record = source as Record<string, unknown>;
    const messageId = record.messageId;
    if (typeof messageId === "string" && messageId) return `${prefix}:${messageId}`;
    const createdAt = record.createdAt;
    const text = record.text;
    if (createdAt !== undefined && typeof text === "string") return `${prefix}:${createdAt}:${text}`;
  }
  return `${prefix}:${crypto.randomUUID()}`;
}
