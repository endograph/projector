import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { AiSdkExecutor } from "@projectors/aisdk-executor";
import { escapeConvexJson, restoreConvexJson, stripClientSchemas } from "./convexJson";
import {
  createDemoClientSnapshot,
  createDemoCharter,
  hydrateDemoInstance,
  serializeDemoInstance,
} from "@projectors/demo-agent/src/projector-demo.js";
import {
  compileProjection,
  createMachine,
  executeCommand,
  inspectCompiledProjectionTree,
  runMachine,
  type Charter,
  type CompiledInference,
  type CompiledProjectionNode,
  type Executor,
  type ExecutorRealizedPrompt,
  type Frame,
  type FrameDraft,
  type Generator,
} from "@projectors/core";
import {
  recordCommandResidue,
  type ClientMachineMessage,
  type MachineSyncState,
} from "@projectors/core/client";
import {
  collectSessionFramePath,
  getFrameIndexForSession,
  listSessionContextFrameDocs,
  listSessionFrameDocs,
  restoreFrame,
} from "./frameHistory";
import { listMessagesForSession } from "./messages";

const DISCRETE_MODEL =
  typeof process !== "undefined"
    ? process.env.OPENAI_DISCRETE_MODEL ?? "gpt-5.5"
    : "gpt-5.5";

type DbCtx = MutationCtx | QueryCtx;
type SessionDoc = Doc<"sessions">;
type FrameDoc = Doc<"frames">;

export const create = mutation({
  args: {
    instanceId: v.string(),
    instance: v.any(),
    syncState: v.optional(v.any()),
  },
  handler: async (ctx, { instanceId, instance, syncState }) => {
    const now = Date.now();
    const sessionId = await ctx.db.insert("sessions", {
      headFrameId: undefined,
      contextEpoch: 0,
      familyRootSessionId: undefined,
      forkedFromSessionId: undefined,
      forkedFromFrameId: undefined,
      syncState,
    });

    const frameId = await ctx.db.insert("frames", {
      parentFrameId: undefined,
      instanceId,
      metadata: escapeConvexJson({ type: "init" }),
      messages: [],
      createdAt: now,
    });
    await ctx.db.insert("frameIndex", {
      sessionId,
      frameId,
      contextEpoch: 0,
    });

    await ctx.db.insert("projectorInstanceLog", {
      sessionId,
      frameId,
      message: escapeConvexJson({ type: "init" }),
      instance,
      createdAt: now,
    });

    await ctx.db.patch(sessionId, {
      headFrameId: frameId,
      familyRootSessionId: sessionId,
    });

    return sessionId;
  },
});

export const get = query({
  args: {
    id: v.id("sessions"),
    headFrameId: v.optional(v.id("frames")),
  },
  handler: async (ctx, { id, headFrameId }) => {
    const session = await ctx.db.get(id);
    if (!session?.headFrameId) return null;

    const effectiveFrameId = headFrameId ?? session.headFrameId;
    if (!(await getFrameIndexForSession(ctx, id, effectiveFrameId))) return null;
    const effectiveFrame = await ctx.db.get(effectiveFrameId);
    if (!effectiveFrame) return null;
    const instance = await getInstanceForFramePath(ctx, session, effectiveFrameId);
    if (!instance) return null;
    const syncState = restoreConvexJson(
      session.syncState ?? { recentCommandResidue: [] },
    ) as MachineSyncState;
    const clientSnapshot = createDemoClientSnapshot(instance, syncState);

    return {
      sessionId: id,
      frameId: effectiveFrameId,
      headFrameId: session.headFrameId,
      contextEpoch: session.contextEpoch,
      familyRootSessionId: session.familyRootSessionId ?? id,
      forkedFromSessionId: session.forkedFromSessionId,
      forkedFromFrameId: session.forkedFromFrameId,
      instanceId: effectiveFrame.instanceId,
      instance,
      clientSnapshot: stripClientSchemas(clientSnapshot),
      syncState,
      recentCommandResidue:
        (syncState.recentCommandResidue as string[] | undefined) ?? [],
      createdAt: effectiveFrame.createdAt,
    };
  },
});

export const getCompiledIr = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const state = await getObservabilityState(ctx, sessionId);
    if (!state) return null;

    return {
      sessionId,
      runtimes: state.runtimes.map((runtime) => {
        const inference = compileRuntimeInference(state, runtime);
        return {
          ...runtime,
          inference: {
            systemParts: inference.systemParts,
            dynamicParts: inference.dynamicParts,
            tools: inference.tools.map((tool) => tool.name),
            retrievableStates: inference.retrievableStates,
          },
        };
      }),
    };
  },
});

export const getRealizedPrompts = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const state = await getObservabilityState(ctx, sessionId);
    if (!state) return null;

    const runtimes = await Promise.all(
      state.runtimes.map(async (runtime) => {
        const inference = compileRuntimeInference(state, runtime);
        let prompt: ExecutorRealizedPrompt;
        try {
          prompt = await state.executor.realizePrompt({
            generatorId: runtime.generatorId,
            runtimeInstanceId: runtime.runtimeInstanceId,
            activationId: "",
            inference,
          });
        } catch (error) {
          prompt = {
            provider: "error",
            input: { message: error instanceof Error ? error.message : String(error) },
          };
        }

        return {
          ...runtime,
          prompt: stripClientSchemas(prompt),
        };
      }),
    );

    return { sessionId, runtimes };
  },
});

type RuntimeInspectionTarget = {
  generatorId: string;
  runtimeInstanceId: string;
  kind: Generator["kind"];
  nodeKey: string;
  name?: string;
};

type ObservabilityState = {
  root: ReturnType<typeof hydrateDemoInstance>;
  charter: Charter;
  frames: Frame[];
  executor: Executor;
  runtimes: RuntimeInspectionTarget[];
};

async function getObservabilityState(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
): Promise<ObservabilityState | null> {
  const session = await ctx.db.get(sessionId);
  if (!session?.headFrameId) return null;

  const instance = await getInstanceForFramePath(ctx, session, session.headFrameId);
  if (!instance) return null;

  const root = hydrateDemoInstance(instance);
  const frames = await getMachineContextFrames(ctx, session);
  const executor = createObservabilityExecutor();
  const charter = createDemoCharter({ executor });
  const tree = inspectCompiledProjectionTree(root, {
    charter,
  });
  const runtimes = collectRuntimeInspectionTargets(tree.roots);

  return {
    root,
    charter,
    frames,
    executor,
    runtimes,
  };
}

function collectRuntimeInspectionTargets(
  nodes: CompiledProjectionNode[],
): RuntimeInspectionTarget[] {
  const targets: RuntimeInspectionTarget[] = [];
  const visit = (node: CompiledProjectionNode) => {
    targets.push({
      generatorId: node.runtimeInstanceId,
      runtimeInstanceId: node.runtimeInstanceId,
      kind: node.kind,
      nodeKey: node.nodeKey,
      ...(node.name ? { name: node.name } : {}),
    });
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return targets;
}

function compileRuntimeInference(
  state: ObservabilityState,
  runtime: RuntimeInspectionTarget,
): CompiledInference {
  return compileProjection(state.root, {
    charter: state.charter,
    targetGenerator: {
      id: runtime.generatorId,
      kind: runtime.kind,
      runtimeInstanceId: runtime.runtimeInstanceId,
    },
    frameHistory: state.frames,
  });
}

function createObservabilityExecutor(): Executor {
  const discreteExecutor = new AiSdkExecutor({
    model: modelRef(DISCRETE_MODEL),
    maxOutputTokens: 4096,
  });
  const memoryExecutor = new AiSdkExecutor({
    model: modelRef(DISCRETE_MODEL),
    maxOutputTokens: 1024,
    maxSteps: 3,
  });
  const isMemoryRequest = (request: { inference: { tools: Array<{ name: string }> } }) =>
    request.inference.tools.some((tool) => tool.name === "saveMemories");

  return {
    run: async () => ({ completionReason: "done" }),
    realizePrompt: (request) =>
      isMemoryRequest(request)
        ? memoryExecutor.realizePrompt(request)
        : discreteExecutor.realizePrompt(request),
  };
}

function modelRef(modelId: string): never {
  return {
    provider: "openai",
    modelId,
  } as never;
}

export const applyClientMessage = mutation({
  args: {
    sessionId: v.id("sessions"),
    message: v.any(),
  },
  handler: async (ctx, { sessionId, message }) => {
    const { session, headFrame, instance } = await getCurrentSessionFrame(ctx, sessionId);
    const syncState = restoreConvexJson(
      session.syncState ?? { recentCommandResidue: [] },
    ) as MachineSyncState;
    const root = hydrateDemoInstance(instance);
    const frames = await getMachineContextFrames(ctx, session);
    const machine = createMachine({
      id: sessionId,
      root,
      charter: createDemoCharter(),
      frames,
    });
    const result = await executeCommand(machine, message as ClientMachineMessage);

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        clientId: (message as ClientMachineMessage).clientId,
      };
    }

    const producedFrames: Frame[] = [];
    for await (const frame of runMachine(machine, { scheduleWork: false })) {
      producedFrames.push(frame);
    }

    const frameIds = await appendMachineFrameSequenceInternal(ctx, {
      sessionId,
      session,
      headFrame,
      frames: producedFrames,
      expectedHeadFrameId: session.headFrameId,
    });
    const nextSyncState = recordCommandResidue(syncState, result.clientId, { limit: 20 });
    await appendProjectorInstanceLog(ctx, {
      sessionId,
      frameId: frameIds.at(-1),
      message,
      instance: escapeConvexJson(serializeDemoInstance(root)),
      syncState: escapeConvexJson(nextSyncState),
    });

    return { success: true, clientId: result.clientId };
  },
});

export const commitMachineInstance = mutation({
  args: {
    sessionId: v.id("sessions"),
    frameId: v.optional(v.id("frames")),
    expectedInstanceFrameId: v.optional(v.id("frames")),
    message: v.optional(v.any()),
    instance: v.any(),
    syncState: v.optional(v.any()),
  },
  handler: async (ctx, { sessionId, frameId, expectedInstanceFrameId, message, instance, syncState }) => {
    const { session, headFrame } = await getCurrentSessionFrame(ctx, sessionId);
    if (expectedInstanceFrameId !== undefined) {
      const latestLog = await getLatestInstanceLogForFramePath(ctx, session, headFrame._id);
      if (latestLog?.frameId !== expectedInstanceFrameId) {
        const latestInstance = latestLog ? restoreConvexJson(latestLog.instance) : instance;
        const currentSyncState = restoreConvexJson(
          session.syncState ?? { recentCommandResidue: [] },
        ) as MachineSyncState;
        return {
          committed: false,
          headFrameId: session.headFrameId,
          instance: latestInstance,
          instanceFrameId: latestLog?.frameId,
          clientSnapshot: stripClientSchemas(createDemoClientSnapshot(latestInstance, currentSyncState)),
        };
      }
    }

    await appendProjectorInstanceLog(ctx, {
      sessionId,
      frameId: frameId ?? session.headFrameId,
      message: message ?? { type: "machine.commit" },
      instance: escapeConvexJson(instance),
      ...(syncState !== undefined ? { syncState: escapeConvexJson(syncState) } : {}),
    });
    const currentSyncState = restoreConvexJson(
      syncState ?? session.syncState ?? { recentCommandResidue: [] },
    ) as MachineSyncState;
    return {
      committed: true,
      headFrameId: session.headFrameId,
      instance,
      instanceFrameId: frameId ?? session.headFrameId,
      clientSnapshot: stripClientSchemas(createDemoClientSnapshot(instance, currentSyncState)),
    };
  },
});

export const getFamilyTimeline = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const selectedSession = await ctx.db.get(sessionId);
    if (!selectedSession) return null;

    const familyRootSessionId = selectedSession.familyRootSessionId ?? selectedSession._id;
    const familySessions = await ctx.db
      .query("sessions")
      .withIndex("by_family_root", (q) => q.eq("familyRootSessionId", familyRootSessionId))
      .collect();
    if (!familySessions.some((session) => session._id === familyRootSessionId)) {
      const rootSession = await ctx.db.get(familyRootSessionId);
      if (rootSession) familySessions.push(rootSession);
    }

    const sessions = await Promise.all(
      familySessions.map(async (session) => {
        const frames = session.headFrameId ? await listSessionFrameDocs(ctx, session._id) : [];
        return {
          sessionId: session._id,
          headFrameId: session.headFrameId,
          contextEpoch: session.contextEpoch,
          forkedFromSessionId: session.forkedFromSessionId,
          forkedFromFrameId: session.forkedFromFrameId,
          frames: frames.map(restoreFrame),
        };
      }),
    );

    return {
      familyRootSessionId,
      sessions,
      edges: familySessions
        .filter((session) => session.forkedFromSessionId && session.forkedFromFrameId)
        .map((session) => ({
          fromSessionId: session.forkedFromSessionId,
          fromFrameId: session.forkedFromFrameId,
          toSessionId: session._id,
        })),
    };
  },
});

export const listMachineContextFrames = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return [];
    return await getMachineContextFrames(ctx, session);
  },
});

export const appendMachineFrame = mutation({
  args: {
    sessionId: v.id("sessions"),
    expectedHeadFrameId: v.id("frames"),
    frame: v.any(),
  },
  handler: async (ctx, { sessionId, expectedHeadFrameId, frame }) => {
    const { session, headFrame } = await getCurrentSessionFrame(ctx, sessionId);
    return await appendMachineFrameInternal(ctx, {
      sessionId,
      session,
      headFrame,
      frame: frame as FrameDraft,
      expectedHeadFrameId,
    });
  },
});

export const appendMachineFrameSequence = mutation({
  args: {
    sessionId: v.id("sessions"),
    expectedHeadFrameId: v.id("frames"),
    frames: v.array(v.any()),
  },
  handler: async (ctx, { sessionId, expectedHeadFrameId, frames }) => {
    const { session, headFrame } = await getCurrentSessionFrame(ctx, sessionId);
    return await appendMachineFrameSequenceInternal(ctx, {
      sessionId,
      session,
      headFrame,
      frames: frames as Frame[],
      expectedHeadFrameId,
    });
  },
});

export const cloneFromFrame = mutation({
  args: {
    sourceSessionId: v.id("sessions"),
    targetFrameId: v.id("frames"),
  },
  handler: async (ctx, { sourceSessionId, targetFrameId }) => {
    const sourceSession = await ctx.db.get(sourceSessionId);
    if (!sourceSession) throw new Error("Source session not found");

    const targetFrameIndex = await getFrameIndexForSession(ctx, sourceSessionId, targetFrameId);
    if (!targetFrameIndex) throw new Error("Target frame not found in source session");

    const sourceFrames = await collectSessionFramePath(ctx, sourceSession, targetFrameId);
    const sourceFrameIds = new Set(sourceFrames.map((frame) => frame._id));
    const instance = await getInstanceForFramePath(ctx, sourceSession, targetFrameId);
    if (!instance) throw new Error("Source session has no instance log for target frame");

    const newSessionId = await ctx.db.insert("sessions", {
      headFrameId: targetFrameId,
      contextEpoch: targetFrameIndex.contextEpoch,
      familyRootSessionId: sourceSession.familyRootSessionId ?? sourceSessionId,
      forkedFromSessionId: sourceSessionId,
      forkedFromFrameId: targetFrameId,
      syncState: escapeConvexJson({ recentCommandResidue: [] }),
    });

    const sourceFrameIndexRows = await ctx.db
      .query("frameIndex")
      .withIndex("by_session", (q) => q.eq("sessionId", sourceSessionId))
      .collect();
    for (const row of sourceFrameIndexRows) {
      if (!sourceFrameIds.has(row.frameId)) continue;
      await ctx.db.insert("frameIndex", {
        sessionId: newSessionId,
        frameId: row.frameId,
        contextEpoch: row.contextEpoch,
      });
    }

    const sourceLogs = await ctx.db
      .query("projectorInstanceLog")
      .withIndex("by_session", (q) => q.eq("sessionId", sourceSessionId))
      .collect();
    for (const log of sourceLogs) {
      if (log.frameId && !sourceFrameIds.has(log.frameId)) continue;
      await ctx.db.insert("projectorInstanceLog", {
        sessionId: newSessionId,
        frameId: log.frameId,
        message: log.message,
        instance: log.instance,
        createdAt: log.createdAt,
      });
    }

    const sourceMessages = await listMessagesForSession(ctx, sourceSessionId);
    for (const message of sourceMessages) {
      if (!message || !sourceFrameIds.has(message.frameId)) continue;
      await ctx.db.insert("messageIndex", {
        sessionId: newSessionId,
        messageId: message._id,
        idempotencyKey: message.idempotencyKey,
      });
    }

    return newSessionId;
  },
});

async function getCurrentSessionFrame(ctx: MutationCtx, sessionId: Id<"sessions">) {
  const session = await ctx.db.get(sessionId);
  if (!session?.headFrameId) {
    throw new Error("Session not found");
  }
  const headFrame = await ctx.db.get(session.headFrameId);
  if (!headFrame) {
    throw new Error("Head frame not found");
  }
  if (!(await getFrameIndexForSession(ctx, sessionId, session.headFrameId))) {
    throw new Error("Head frame is not indexed for session");
  }
  const instance = await getInstanceForFramePath(ctx, session, session.headFrameId);
  if (!instance) {
    throw new Error("Session has no instance log");
  }
  return { session, headFrame, instance };
}

async function appendMachineFrameInternal(
  ctx: MutationCtx,
  {
    sessionId,
    session,
    headFrame,
    frame,
    expectedHeadFrameId,
  }: {
    sessionId: Id<"sessions">;
    session: SessionDoc;
    headFrame: FrameDoc;
    frame: FrameDraft | Frame;
    expectedHeadFrameId?: Id<"frames">;
  },
) {
  if (expectedHeadFrameId) {
    assertExpectedHead(session, expectedHeadFrameId);
  }

  const metadata =
    "id" in frame && typeof frame.id === "string"
      ? { ...(frame.metadata ?? {}), projectorFrameId: frame.id }
      : frame.metadata;
  const frameId = await ctx.db.insert("frames", {
    parentFrameId: session.headFrameId,
    instanceId: headFrame.instanceId,
    ...(frame.generatorId !== undefined ? { generatorId: frame.generatorId } : {}),
    ...(frame.runtimeInstanceId !== undefined ? { runtimeInstanceId: frame.runtimeInstanceId } : {}),
    ...(frame.activationId !== undefined ? { activationId: frame.activationId } : {}),
    ...(frame.inert !== undefined ? { inert: frame.inert } : {}),
    ...(metadata !== undefined ? { metadata: escapeConvexJson(metadata) } : {}),
    messages: escapeConvexJson(frame.messages),
    createdAt: Date.now(),
  });
  await ctx.db.insert("frameIndex", {
    sessionId,
    frameId,
    contextEpoch: session.contextEpoch,
  });
  await ctx.db.patch(sessionId, {
    headFrameId: frameId,
  });
  return frameId;
}

async function appendMachineFrameSequenceInternal(
  ctx: MutationCtx,
  {
    sessionId,
    session,
    headFrame,
    frames,
    expectedHeadFrameId,
  }: {
    sessionId: Id<"sessions">;
    session: SessionDoc;
    headFrame: FrameDoc;
    frames: Frame[];
    expectedHeadFrameId?: Id<"frames">;
  },
) {
  if (expectedHeadFrameId) {
    assertExpectedHead(session, expectedHeadFrameId);
  }

  const frameIds: Id<"frames">[] = [];
  let currentSession = session;
  let currentHead = headFrame;

  for (const frame of frames) {
    const frameId = await appendMachineFrameInternal(ctx, {
      sessionId,
      session: currentSession,
      headFrame: currentHead,
      frame,
    });
    frameIds.push(frameId);

    const nextSession = await ctx.db.get(sessionId);
    const nextHead = await ctx.db.get(frameId);
    if (!nextSession || !nextHead) {
      throw new Error("Failed to append machine frame");
    }
    currentSession = nextSession;
    currentHead = nextHead;
  }

  return frameIds;
}

function assertExpectedHead(session: SessionDoc, expectedHeadFrameId: Id<"frames">) {
  if (session.headFrameId !== expectedHeadFrameId) {
    throw new ConvexError({
      code: "stale_head",
      expectedHeadFrameId,
      headFrameId: session.headFrameId,
    });
  }
}

async function appendProjectorInstanceLog(
  ctx: MutationCtx,
  {
    sessionId,
    frameId,
    message,
    instance,
    syncState,
  }: {
    sessionId: Id<"sessions">;
    frameId: Id<"frames"> | undefined;
    message: unknown;
    instance: unknown;
    syncState?: unknown;
  },
) {
  await ctx.db.insert("projectorInstanceLog", {
    sessionId,
    frameId,
    message: escapeConvexJson(message),
    instance,
    createdAt: Date.now(),
  });
  if (syncState !== undefined) {
    await ctx.db.patch(sessionId, { syncState });
  }
}

async function getInstanceForFramePath(
  ctx: DbCtx,
  session: SessionDoc,
  frameId: Id<"frames">,
) {
  const log = await getLatestInstanceLogForFramePath(ctx, session, frameId);
  return log ? restoreConvexJson(log.instance) : null;
}

async function getLatestInstanceLogForFramePath(
  ctx: DbCtx,
  session: SessionDoc,
  frameId: Id<"frames">,
) {
  const path = await collectSessionFramePath(ctx, session, frameId);
  const frameIds = new Set(path.map((frame) => frame._id));
  const logs = await ctx.db
    .query("projectorInstanceLog")
    .withIndex("by_session", (q) => q.eq("sessionId", session._id))
    .collect();
  return logs
    .filter((entry) => !entry.frameId || frameIds.has(entry.frameId))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

async function getMachineContextFrames(ctx: DbCtx, session: SessionDoc): Promise<Frame[]> {
  return (await listSessionContextFrameDocs(ctx, session)).map(restoreFrame) as Frame[];
}
