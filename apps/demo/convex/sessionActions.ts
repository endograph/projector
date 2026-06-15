"use node";

import { action } from "./_generated/server";
import { api } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { openai as aiSdkOpenAI } from "@ai-sdk/openai";
import { AiSdkExecutor } from "@projectors/aisdk-executor";
import {
  createMachine,
  encodeRuntimeAddress,
  runMachine,
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

const DISCRETE_MODEL = process.env.OPENAI_DISCRETE_MODEL ?? "gpt-4o-mini";

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
    const rootRuntimeInstanceId = encodeRuntimeAddress({
      type: "instance",
      instanceId: rootInstance.id,
    });
    const memoryRuntimeInstanceId = encodeRuntimeAddress({
      type: "member",
      ownerInstanceId: rootInstance.id,
      memberPath: ["memory"],
    });
    const branchFrames = (await ctx.runQuery(api.sessions.listBranchFrames, { sessionId })) as Frame[];
    const memoryExecutor = new AiSdkExecutor({
      model: aiSdkOpenAI(DISCRETE_MODEL),
      maxOutputTokens: 1024,
      maxSteps: 3,
      toolChoice: "required",
    });
    const executor: Executor = {
      run: (request) =>
        request.runtimeInstanceId === memoryRuntimeInstanceId
          ? memoryExecutor.run(request)
          : discreteExecutor.run(request),
    };
    const machine = createMachine({
      id: sessionId,
      root: rootInstance,
      charter: { ...createDemoCharter(), executor },
      frames: branchFrames,
    });

    machine.enqueueFrame({
      metadata: { mode: "text", transport: "convex" },
      messages: [{ type: "user", text: content }],
    });

    let lastFrameId: Id<"machineFrames"> | undefined;
    for await (const frame of runMachine(machine)) {
      const frameId = await persistMachineFrame(ctx, {
        sessionId,
        frame,
        rootRuntimeInstanceId,
      });
      lastFrameId = frameId;
    }

    await ctx.runMutation(api.sessions.commitMachineInstance, {
      sessionId,
      frameId: lastFrameId,
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

async function persistMachineFrame(
  ctx: ActionCtx,
  {
    sessionId,
    frame,
    rootRuntimeInstanceId,
  }: {
    sessionId: Id<"sessions">;
    frame: Frame;
    rootRuntimeInstanceId: string;
  },
): Promise<Id<"machineFrames">> {
  const mode =
    frame.metadata?.mode === "text" || frame.runtimeInstanceId === rootRuntimeInstanceId
      ? "text"
      : "memory";
  const frameId = await ctx.runMutation(api.sessions.appendMachineFrame, {
    sessionId,
    frame: {
      ...frame,
      metadata: {
        ...frame.metadata,
        mode,
        transport: "convex",
      },
    },
  });

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

  return frameId;
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
