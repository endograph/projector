"use node";

import { action } from "./_generated/server";
import { api } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { openai as aiSdkOpenAI } from "@ai-sdk/openai";
import { AiSdkExecutor } from "@projectors/aisdk-executor";
import {
  ROOT_RUNTIME_INSTANCE_ID,
  createMachine,
  runMachine,
  textContent,
  type Executor,
  type Frame,
} from "@projectors/core";
import { escapeConvexJson } from "./convexJson";
import {
  createInitialSerializedInstance,
  createDemoCharter,
  hydrateDemoInstance,
  serializeDemoInstance,
} from "@projectors/demo-agent/src/projector-demo.js";
import type { ClientMachineMessage } from "@projectors/core/client";

const DISCRETE_MODEL = process.env.OPENAI_DISCRETE_MODEL ?? "gpt-5.5";

const discreteExecutor = new AiSdkExecutor({
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
  },
  handler: async (ctx, { sessionId, content }): Promise<{ success: true }> => {
    const session = await ctx.runQuery(api.sessions.get, { id: sessionId });
    if (!session) {
      throw new Error("Session not found");
    }

    const rootInstance = hydrateDemoInstance(session.instance);
    const contextFrames = (await ctx.runQuery(api.sessions.listMachineContextFrames, { sessionId })) as Frame[];
    const memoryExecutor = new AiSdkExecutor({
      model: aiSdkOpenAI(DISCRETE_MODEL),
      maxOutputTokens: 1024,
      maxSteps: 3,
    });
    const isMemoryRequest = (request: { inference: { tools: Array<{ name: string }> } }) =>
      request.inference.tools.some((tool) => tool.name === "saveMemories");
    const executor: Executor = {
      run: (request) =>
        isMemoryRequest(request)
          ? memoryExecutor.run(request)
          : discreteExecutor.run(request),
      realizePrompt: (request) =>
        isMemoryRequest(request)
          ? memoryExecutor.realizePrompt(request)
          : discreteExecutor.realizePrompt(request),
    };
    const machine = createMachine({
      id: sessionId,
      root: rootInstance,
      charter: { ...createDemoCharter(), executor },
      frames: contextFrames,
    });

    machine.enqueueFrame({
      metadata: { mode: "text", transport: "convex" },
      messages: [{ type: "user", content: [textContent(content)], text: content }],
    });

    const producedFrames: Frame[] = [];
    for await (const frame of runMachine(machine)) {
      producedFrames.push(frame);
    }

    const durableFrames = producedFrames.map((frame) =>
      prepareMachineFrame(frame, ROOT_RUNTIME_INSTANCE_ID)
    );
    const frameIds = await ctx.runMutation(api.sessions.appendMachineFrameSequence, {
      sessionId,
      expectedHeadFrameId: session.headFrameId,
      frames: durableFrames,
    }) as Id<"frames">[];

    for (const [index, frame] of durableFrames.entries()) {
      const frameId = frameIds[index];
      if (!frameId) continue;
      await persistFrameMessages(ctx, {
        sessionId,
        frame,
        frameId,
        rootRuntimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
      });
    }

    await ctx.runMutation(api.sessions.commitMachineInstance, {
      sessionId,
      frameId: frameIds.at(-1),
      message: { type: "machine.run", trigger: "user", text: content },
      instance: serializeDemoInstance(rootInstance),
    });

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

    if ((message as ClientMachineMessage).name === "incrementTestCounter") {
      await delay(4000);
    }

    return await ctx.runMutation(api.sessions.applyClientMessage, {
      sessionId,
      message: message as ClientMachineMessage,
    });
  },
});

export const createSessionAtFoo = createSession;

function prepareMachineFrame(frame: Frame, rootRuntimeInstanceId: string): Frame {
  const mode =
    frame.metadata?.mode === "text" || frame.runtimeInstanceId === rootRuntimeInstanceId
      ? "text"
      : "memory";
  return {
    ...frame,
    metadata: {
      ...frame.metadata,
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
    rootRuntimeInstanceId,
  }: {
    sessionId: Id<"sessions">;
    frame: Frame;
    frameId: Id<"frames">;
    rootRuntimeInstanceId: string;
  },
): Promise<void> {
  for (const message of frame.messages) {
    const text = typeof message.text === "string" ? message.text : "";
    if (message.type === "user" && text.trim()) {
      await ctx.runMutation(api.messages.add, {
        sessionId,
        role: "user",
        content: text,
        frameId,
        mode: "text",
        idempotencyKey: idempotencyKey("user", message),
      });
    }

    if (
      message.type === "assistant" &&
      frame.runtimeInstanceId === rootRuntimeInstanceId &&
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
