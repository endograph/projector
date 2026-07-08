import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { AiSdkExecutor } from "@projectors/aisdk-executor";
import { escapeConvexJson, restoreConvexJson, stripClientSchemas } from "./convexJson";
import {
  createDemoClientSnapshot,
  createDemoCharter,
  hydrateDemoInstance,
  hydrateDemoSourceInstance,
  serializeDemoSourceInstance,
} from "@projectors/demo-agent/src/projector-demo.js";
import {
  applyInstanceMessage,
  compileProjection,
  createMachine,
  inspectCompiledProjectionTree,
  type Charter,
  type CompiledInference,
  type CompiledContributor,
  type Executor,
  type ExecutorRealizedPrompt,
  type Frame,
  type FrameDraft,
  type InstanceMessage,
} from "@projectors/core";
import {
  recordCommandResidue,
  type MachineSyncState,
} from "@projectors/core/client";
import {
  collectSessionFramePath,
  getLatestSessionFrameDoc,
  getFrameIndexForSession,
  listSessionContextFrameDocs,
  listSessionFrameDocs,
  restoreFrame,
} from "./frameHistory";
import { listMessagesForSession } from "./messages";
import type { DemoAttachmentData } from "@projectors/demo-agent/src/attachments.js";

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
      contextEpoch: 0,
      familyRootSessionId: undefined,
      forkedFromSessionId: undefined,
      forkedFromFrameId: undefined,
      syncState,
    });

    const frameId = await ctx.db.insert("frames", {
      referenceFrameId: undefined,
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
      instanceId,
      frameId,
      message: escapeConvexJson({ type: "init" }),
      instance,
      createdAt: now,
    });

    await ctx.db.patch(sessionId, {
      familyRootSessionId: sessionId,
    });

    return sessionId;
  },
});

export const get = query({
  args: {
    id: v.id("sessions"),
    timetravelFrameId: v.optional(v.id("frames")),
  },
  handler: async (ctx, { id, timetravelFrameId }) => {
    const session = await ctx.db.get(id);
    if (!session) return null;

    const latestFrame = await getLatestSessionFrameDoc(ctx, id);
    const effectiveFrameId = timetravelFrameId ?? latestFrame?._id;
    if (!effectiveFrameId) return null;
    if (!(await getFrameIndexForSession(ctx, id, effectiveFrameId))) return null;
    const effectiveFrame = await ctx.db.get(effectiveFrameId);
    if (!effectiveFrame) return null;
    const instance = await getInstanceForFramePath(ctx, session, effectiveFrameId);
    if (!instance) return null;
    const syncState = restoreConvexJson(
      session.syncState ?? { recentCommandResidue: [] },
    ) as MachineSyncState;
    const clientSnapshot = createDemoClientSnapshot(instance, id, syncState);

    return {
      sessionId: id,
      frameId: effectiveFrameId,
      contextEpoch: session.contextEpoch,
      familyRootSessionId: session.familyRootSessionId ?? id,
      forkedFromSessionId: session.forkedFromSessionId,
      forkedFromFrameId: session.forkedFromFrameId,
      instanceId: instance.id,
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
            preamble: inference.preamble,
            recency: inference.recency,
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
  kind: "generator";
  nodeKey: string;
  name?: string;
};

type ObservabilityState = {
  root: ReturnType<typeof hydrateDemoInstance>;
  charter: Charter<DemoAttachmentData>;
  frames: Frame<DemoAttachmentData>[];
  executor: Executor<DemoAttachmentData>;
  runtimes: RuntimeInspectionTarget[];
};

async function getObservabilityState(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
): Promise<ObservabilityState | null> {
  const session = await ctx.db.get(sessionId);
  if (!session) return null;
  const latestFrame = await getLatestSessionFrameDoc(ctx, sessionId);
  if (!latestFrame) return null;

  const instance = await getInstanceForFramePath(ctx, session, latestFrame._id);
  if (!instance) return null;

  const root = hydrateDemoInstance(instance, sessionId);
  const frames = await getMachineContextFrames(ctx, session);
  const executor = createObservabilityExecutor();
  const charter = createDemoCharter();
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
  nodes: CompiledContributor<DemoAttachmentData>[],
): RuntimeInspectionTarget[] {
  const targets: RuntimeInspectionTarget[] = [];
  const visit = (node: CompiledContributor<DemoAttachmentData>) => {
    targets.push({
      generatorId: node.id,
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
): CompiledInference<DemoAttachmentData> {
  return compileProjection(state.root, {
    charter: state.charter,
    targetGeneratorId: runtime.generatorId,
    frameHistory: state.frames,
  });
}

function createObservabilityExecutor(): Executor<DemoAttachmentData> {
  const discreteExecutor = new AiSdkExecutor<DemoAttachmentData>({
    model: modelRef(DISCRETE_MODEL),
    maxOutputTokens: 4096,
  });
  const memoryExecutor = new AiSdkExecutor<DemoAttachmentData>({
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
        const frames = await listSessionFrameDocs(ctx, session._id);
        return {
          sessionId: session._id,
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

export const incrementContextEpoch = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await getSessionOrThrow(ctx, sessionId);
    const nextEpoch = session.contextEpoch + 1;
    await ctx.db.patch(sessionId, { contextEpoch: nextEpoch });
    const workerRoom = await ctx.db
      .query("agentWorkerRooms")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    if (workerRoom) {
      await ctx.db.patch(workerRoom._id, {
        agentWorkerId: undefined,
        agentWorkerLeaseToken: undefined,
        agentWorkerLeaseExpiresAt: 0,
        agentWorkerHeartbeatAt: Date.now(),
        agentLastStatusAt: Date.now(),
      });
    }
    return { contextEpoch: nextEpoch };
  },
});

export const appendMachineFrame = mutation({
  args: {
    sessionId: v.id("sessions"),
    referenceFrameId: v.optional(v.id("frames")),
    frame: v.any(),
  },
  handler: async (ctx, { sessionId, referenceFrameId, frame }) => {
    const session = await getSessionOrThrow(ctx, sessionId);
    return await appendMachineFrameInternal(ctx, {
      sessionId,
      session,
      frame: frame as FrameDraft,
      referenceFrameId,
    });
  },
});

export const appendMachineFrameSequence = mutation({
  args: {
    sessionId: v.id("sessions"),
    referenceFrameId: v.optional(v.id("frames")),
    frames: v.array(v.any()),
  },
  handler: async (ctx, { sessionId, referenceFrameId, frames }) => {
    const session = await getSessionOrThrow(ctx, sessionId);
    return await appendMachineFrameSequenceInternal(ctx, {
      sessionId,
      session,
      referenceFrameId,
      frames: frames as Frame[],
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
        instanceId: log.instanceId,
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

async function getSessionOrThrow(ctx: MutationCtx, sessionId: Id<"sessions">) {
  const session = await ctx.db.get(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  return session;
}

async function appendMachineFrameInternal(
  ctx: MutationCtx,
  {
    sessionId,
    session,
    frame,
    referenceFrameId,
  }: {
    sessionId: Id<"sessions">;
    session: SessionDoc;
    frame: (FrameDraft | Frame) & { metadata?: Record<string, unknown> };
    referenceFrameId?: Id<"frames">;
  },
) {
  const effectiveReferenceFrameId = referenceFrameId ?? (await getLatestSessionFrameDoc(ctx, sessionId))?._id;
  if (effectiveReferenceFrameId && !(await getFrameIndexForSession(ctx, sessionId, effectiveReferenceFrameId))) {
    throw new Error("Reference frame is not indexed for session");
  }

  const metadata =
    "id" in frame && typeof frame.id === "string"
      ? { ...(frame.metadata ?? {}), projectorFrameId: frame.id }
      : frame.metadata;
  const frameId = await ctx.db.insert("frames", {
    referenceFrameId: effectiveReferenceFrameId,
    ...(frame.generatorId !== undefined ? { generatorId: frame.generatorId } : {}),
    ...(frame.activationId !== undefined ? { activationId: frame.activationId } : {}),
    ...(frame.inert !== undefined ? { inert: frame.inert } : {}),
    ...(metadata !== undefined ? { metadata: escapeConvexJson(metadata) } : {}),
    ...(frame.provenance !== undefined ? { provenance: escapeConvexJson(frame.provenance) } : {}),
    messages: escapeConvexJson(frame.messages),
    createdAt: Date.now(),
  });
  await ctx.db.insert("frameIndex", {
    sessionId,
    frameId,
    contextEpoch: session.contextEpoch,
  });
  await applyFrameInstanceMessages(ctx, sessionId, frameId, frame.messages);
  await recordFrameCommandResidue(ctx, sessionId, frame.messages);
  return frameId;
}

async function recordFrameCommandResidue(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  messages: readonly FrameDraft["messages"][number][],
): Promise<void> {
  const callIds = messages
    .filter(
      (message) =>
        message.type === "action" &&
        message.kind === "result" &&
        message.action === "command" &&
        typeof message.callId === "string" &&
        message.callId.length > 0,
    )
    .map((message) => message.callId as string);
  if (callIds.length === 0) return;

  const session = await ctx.db.get(sessionId);
  if (!session) return;

  const syncState = restoreConvexJson(
    session.syncState ?? { recentCommandResidue: [] },
  ) as MachineSyncState;
  const nextSyncState = callIds.reduce(
    (state, callId) => recordCommandResidue(state, callId, { limit: 20 }),
    syncState,
  );
  await ctx.db.patch(sessionId, {
    syncState: escapeConvexJson(nextSyncState),
  });
}

async function appendMachineFrameSequenceInternal(
  ctx: MutationCtx,
  {
    sessionId,
    session,
    referenceFrameId,
    frames,
  }: {
    sessionId: Id<"sessions">;
    session: SessionDoc;
    referenceFrameId?: Id<"frames">;
    frames: Frame[];
  },
) {
  const frameIds: Id<"frames">[] = [];
  let currentReferenceFrameId = referenceFrameId;

  for (const frame of frames) {
    const frameId = await appendMachineFrameInternal(ctx, {
      sessionId,
      session,
      referenceFrameId: currentReferenceFrameId,
      frame,
    });
    frameIds.push(frameId);
    currentReferenceFrameId = frameId;
  }

  return frameIds;
}

async function applyFrameInstanceMessages(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  frameId: Id<"frames">,
  messages: Frame["messages"],
): Promise<void> {
  for (const message of messages) {
    if (!isInstanceMessage(message)) continue;
    await applyFrameInstanceMessage(ctx, sessionId, frameId, message);
  }
}

async function applyFrameInstanceMessage(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  frameId: Id<"frames">,
  message: InstanceMessage,
): Promise<void> {
  const targetInstanceId = instanceMessageTargetId(message);
  const source = await getLatestSourceForInstanceMessage(ctx, sessionId, message, targetInstanceId);
  if (!source) {
    throw new Error(`No source instance contains target instance "${targetInstanceId}"`);
  }

  applyInstanceMessage(source, message, createDemoCharter());

  await ctx.db.insert("projectorInstanceLog", {
    sessionId,
    instanceId: source.id,
    frameId,
    message: escapeConvexJson(message),
    instance: escapeConvexJson(serializeDemoSourceInstance(source)),
    createdAt: Date.now(),
  });
}

function instanceMessageTargetId(message: InstanceMessage): string {
  if (message.kind === "spawn" || message.kind === "attach") {
    return message.parentInstanceId;
  }
  return message.instanceId;
}

async function getLatestSourceForInstanceMessage(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
  message: InstanceMessage,
  targetInstanceId: string,
) {
  const source = await getLatestSourceContainingInstance(ctx, sessionId, targetInstanceId);
  if (source || message.kind !== "remove") {
    return source;
  }

  return await getLatestSource(ctx, sessionId);
}

function isInstanceMessage(message: unknown): message is InstanceMessage {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return record.type === "instance" &&
    (record.kind === "state.update" ||
      record.kind === "transition" ||
      record.kind === "spawn" ||
      record.kind === "attach" ||
      record.kind === "remove");
}

async function getLatestSourceContainingInstance(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
  targetInstanceId: string,
) {
  const latestLogs = await getLatestSourceLogs(ctx, sessionId);
  for (const log of latestLogs) {
    const source = hydrateDemoSourceInstance(restoreConvexJson(log.instance));
    if (containsInstance(source, targetInstanceId)) {
      return source;
    }
  }
  return null;
}

async function getLatestSource(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
) {
  const [latestLog] = await getLatestSourceLogs(ctx, sessionId);
  return latestLog ? hydrateDemoSourceInstance(restoreConvexJson(latestLog.instance)) : null;
}

async function getLatestSourceLogs(ctx: DbCtx, sessionId: Id<"sessions">) {
  const logs = await ctx.db
    .query("projectorInstanceLog")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  const latestByInstance = new Map<string, Doc<"projectorInstanceLog">>();
  for (const log of logs.sort((a, b) => a.createdAt - b.createdAt || a._id.localeCompare(b._id))) {
    latestByInstance.set(log.instanceId, log);
  }
  return [...latestByInstance.values()].sort((a, b) => b.createdAt - a.createdAt || b._id.localeCompare(a._id));
}

function containsInstance(instance: ReturnType<typeof hydrateDemoSourceInstance>, targetInstanceId: string): boolean {
  if (instance.id === targetInstanceId) return true;
  return (instance.children ?? []).some((child) => containsInstance(child, targetInstanceId));
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
    .sort((a, b) => b.createdAt - a.createdAt || b._id.localeCompare(a._id))[0];
}

async function getMachineContextFrames(ctx: DbCtx, session: SessionDoc): Promise<Frame[]> {
  return (await listSessionContextFrameDocs(ctx, session)).map(restoreFrame) as Frame[];
}
