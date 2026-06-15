import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { escapeConvexJson, restoreConvexJson, stripClientSchemas } from "./convexJson";
import {
  createDemoClientSnapshot,
  createDemoCharter,
  hydrateDemoInstance,
  serializeDemoInstance,
} from "@projectors/demo-agent/src/projector-demo.js";
import {
  createMachine,
  executeCommand,
  runMachine,
  type Frame,
  type FrameDraft,
} from "@projectors/core";
import {
  recordCommandResidue,
  type ClientMachineMessage,
  type MachineSyncState,
} from "@projectors/core/client";

export const create = mutation({
  args: {
    instanceId: v.string(),
    instance: v.any(),
    syncState: v.optional(v.any()),
  },
  handler: async (ctx, { instanceId, instance, syncState }) => {
    const sessionId = await ctx.db.insert("sessions", {
      headFrameId: undefined,
      branchRootFrameId: undefined,
      branchAncestors: undefined,
    });

    const frameId = await ctx.db.insert("machineFrames", {
      sessionId,
      parentFrameId: undefined,
      branchRootFrameId: undefined,
      instanceId,
      metadata: { type: "init" },
      messages: [],
      createdAt: Date.now(),
    });

    await ctx.db.insert("projectorInstanceLog", {
      sessionId,
      frameId,
      parentFrameId: undefined,
      message: { type: "init" },
      instance,
      createdAt: Date.now(),
    });

    await ctx.db.patch(frameId, { branchRootFrameId: frameId });
    await ctx.db.patch(sessionId, {
      headFrameId: frameId,
      branchRootFrameId: frameId,
      branchAncestors: [frameId],
      syncState,
    } as any);

    return sessionId;
  },
});

export const get = query({
  args: { id: v.id("sessions") },
  handler: async (ctx, { id }) => {
    const session = await ctx.db.get(id);
    if (!session?.headFrameId) return null;

    const headFrame = await ctx.db.get(session.headFrameId);
    if (!headFrame) return null;
    const instance = await getInstanceForFramePath(ctx, session, session.headFrameId);
    if (!instance) return null;
    const syncState = restoreConvexJson(
      (session as any).syncState ?? { recentCommandResidue: [] },
    ) as MachineSyncState;
    const clientSnapshot = createDemoClientSnapshot(instance, syncState);

    return {
      sessionId: id,
      frameId: session.headFrameId,
      headFrameId: session.headFrameId,
      branchRootFrameId: session.branchRootFrameId,
      branchAncestors: session.branchAncestors ?? [session.headFrameId],
      instanceId: headFrame.instanceId,
      instance,
      clientSnapshot: stripClientSchemas(clientSnapshot),
      syncState,
      recentCommandResidue:
        (syncState.recentCommandResidue as string[] | undefined) ?? [],
      createdAt: headFrame.createdAt,
    };
  },
});

export const applyClientMessage = mutation({
  args: {
    sessionId: v.id("sessions"),
    message: v.any(),
  },
  handler: async (ctx, { sessionId, message }) => {
    const { session, headFrame, instance } = await getCurrentSessionFrame(ctx, sessionId);
    const syncState = restoreConvexJson(
      (session as any).syncState ?? { recentCommandResidue: [] },
    ) as MachineSyncState;
    const root = hydrateDemoInstance(instance);
    const frames = await getBranchFrames(ctx, session);
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
    for await (const frame of runMachine(machine, { startWork: false })) {
      producedFrames.push(frame);
    }

    const frameIds = await appendMachineFrameSequence(ctx, {
      sessionId,
      session,
      headFrame,
      frames: producedFrames,
    });
    const nextSyncState = recordCommandResidue(syncState, result.clientId, { limit: 20 });
    await appendProjectorInstanceLog(ctx, {
      sessionId,
      session,
      headFrame,
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
    frameId: v.optional(v.id("machineFrames")),
    expectedInstanceFrameId: v.optional(v.id("machineFrames")),
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
          (session as any).syncState ?? { recentCommandResidue: [] },
        ) as MachineSyncState;
        return {
          committed: false,
          instance: latestInstance,
          instanceFrameId: latestLog?.frameId,
          clientSnapshot: stripClientSchemas(createDemoClientSnapshot(latestInstance, currentSyncState)),
        };
      }
    }

    await appendProjectorInstanceLog(ctx, {
      sessionId,
      session,
      headFrame,
      frameId: frameId ?? session.headFrameId,
      message: message ?? { type: "machine.commit" },
      instance: escapeConvexJson(instance),
      ...(syncState !== undefined ? { syncState: escapeConvexJson(syncState) } : {}),
    });
    const currentSyncState = restoreConvexJson(
      syncState ?? (session as any).syncState ?? { recentCommandResidue: [] },
    ) as MachineSyncState;
    return {
      committed: true,
      instance,
      instanceFrameId: frameId ?? session.headFrameId,
      clientSnapshot: stripClientSchemas(createDemoClientSnapshot(instance, currentSyncState)),
    };
  },
});

export const getFullHistory = query({
  args: { sessionId: v.id("sessions") },
  handler: async () => [],
});

export const getFrameTree = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return null;
    const frames = await ctx.db
      .query("machineFrames")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
    return {
      headFrameId: session.headFrameId,
      branchRootFrameId: session.branchRootFrameId,
      branchAncestors: session.branchAncestors,
      frames: frames.map((frame) => restoreFrame(frame)),
    };
  },
});

export const listBranchFrames = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return [];
    return await getBranchFrames(ctx, session);
  },
});

export const appendMachineFrame = mutation({
  args: {
    sessionId: v.id("sessions"),
    frame: v.any(),
  },
  handler: async (ctx, { sessionId, frame }) => {
    const { session, headFrame } = await getCurrentSessionFrame(ctx, sessionId);
    return await appendMachineFrameInternal(ctx, {
      sessionId,
      session,
      headFrame,
      frame: frame as FrameDraft,
    });
  },
});

export const timeTravel = mutation({
  args: {
    sessionId: v.id("sessions"),
    targetFrameId: v.id("machineFrames"),
  },
  handler: async (ctx, { sessionId, targetFrameId }) => {
    const targetFrame = await ctx.db.get(targetFrameId);
    if (!targetFrame) throw new Error("Target frame not found");

    const ancestors = await collectAncestorPath(ctx, targetFrameId);
    await ctx.db.patch(sessionId, {
      headFrameId: targetFrameId,
      branchRootFrameId: targetFrame.branchRootFrameId ?? targetFrameId,
      branchAncestors: ancestors,
    });
  },
});

async function collectAncestorPath(ctx: MutationCtx, frameId: Id<"machineFrames">) {
  const reversed: Id<"machineFrames">[] = [];
  let nextFrameId: Id<"machineFrames"> | undefined = frameId;
  while (nextFrameId) {
    const frame: Doc<"machineFrames"> | null = await ctx.db.get(nextFrameId);
    if (!frame) break;
    reversed.push(nextFrameId);
    nextFrameId = frame.parentFrameId;
  }
  return reversed.reverse();
}

async function getCurrentSessionFrame(ctx: MutationCtx, sessionId: Id<"sessions">) {
  const session = await ctx.db.get(sessionId);
  if (!session?.headFrameId || !session.branchRootFrameId) {
    throw new Error("Session not found");
  }
  const headFrame = await ctx.db.get(session.headFrameId);
  if (!headFrame) {
    throw new Error("Head frame not found");
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
  }: {
    sessionId: Id<"sessions">;
    session: Doc<"sessions">;
    headFrame: Doc<"machineFrames">;
    frame: FrameDraft | Frame;
  },
) {
  const metadata =
    "id" in frame && typeof frame.id === "string"
      ? { ...(frame.metadata ?? {}), projectorFrameId: frame.id }
      : frame.metadata;
  const frameId = await ctx.db.insert("machineFrames", {
    sessionId,
    parentFrameId: session.headFrameId,
    branchRootFrameId: session.branchRootFrameId,
    instanceId: headFrame.instanceId,
    ...(frame.generatorId !== undefined ? { generatorId: frame.generatorId } : {}),
    ...(frame.runtimeInstanceId !== undefined ? { runtimeInstanceId: frame.runtimeInstanceId } : {}),
    ...(frame.activationId !== undefined ? { activationId: frame.activationId } : {}),
    ...(frame.inert !== undefined ? { inert: frame.inert } : {}),
    ...(metadata !== undefined ? { metadata: escapeConvexJson(metadata) } : {}),
    messages: escapeConvexJson(frame.messages),
    createdAt: Date.now(),
  });
  await ctx.db.patch(sessionId, {
    headFrameId: frameId,
    branchAncestors: [...(session.branchAncestors ?? [headFrame._id]), frameId],
  });
  return frameId;
}

async function appendMachineFrameSequence(
  ctx: MutationCtx,
  {
    sessionId,
    session,
    headFrame,
    frames,
  }: {
    sessionId: Id<"sessions">;
    session: Doc<"sessions">;
    headFrame: Doc<"machineFrames">;
    frames: Frame[];
  },
) {
  const frameIds: Id<"machineFrames">[] = [];
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

async function appendProjectorInstanceLog(
  ctx: MutationCtx,
  {
    sessionId,
    session,
    headFrame,
    frameId,
    message,
    instance,
    syncState,
  }: {
    sessionId: Id<"sessions">;
    session: Doc<"sessions">;
    headFrame: Doc<"machineFrames">;
    frameId: Id<"machineFrames"> | undefined;
    message: unknown;
    instance: unknown;
    syncState?: unknown;
  },
) {
  await ctx.db.insert("projectorInstanceLog", {
    sessionId,
    frameId,
    parentFrameId: headFrame._id,
    message: escapeConvexJson(message),
    instance,
    createdAt: Date.now(),
  });
  await ctx.db.patch(sessionId, {
    ...(syncState ? { syncState } : {}),
  } as any);
}

async function getInstanceForFramePath(
  ctx: MutationCtx | QueryCtx,
  session: Doc<"sessions">,
  frameId: Id<"machineFrames">,
) {
  const log = await getLatestInstanceLogForFramePath(ctx, session, frameId);
  return log ? restoreConvexJson(log.instance) : null;
}

async function getLatestInstanceLogForFramePath(
  ctx: MutationCtx | QueryCtx,
  session: Doc<"sessions">,
  frameId: Id<"machineFrames">,
) {
  const ancestors = new Set<Id<"machineFrames">>(session.branchAncestors ?? [frameId]);
  const logs = await ctx.db
    .query("projectorInstanceLog")
    .withIndex("by_session", (q) => q.eq("sessionId", session._id))
    .collect();
  return logs
    .filter((entry) => !entry.frameId || ancestors.has(entry.frameId))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

async function getBranchFrames(ctx: MutationCtx | QueryCtx, session: Doc<"sessions">) {
  if (!session.headFrameId) return [];
  const ancestors = session.branchAncestors ?? [session.headFrameId];
  const frames = await Promise.all(ancestors.map((frameId) => ctx.db.get(frameId)));
  return frames
    .filter((frame): frame is Doc<"machineFrames"> => frame !== null)
    .map(restoreFrame) as Frame[];
}

function restoreFrame(frame: Doc<"machineFrames">) {
  const metadata = frame.metadata ? restoreConvexJson(frame.metadata) : undefined;
  const projectorFrameId =
    metadata &&
    typeof metadata === "object" &&
    typeof (metadata as Record<string, unknown>).projectorFrameId === "string"
      ? ((metadata as Record<string, unknown>).projectorFrameId as string)
      : frame._id;
  return {
    ...frame,
    id: projectorFrameId,
    messages: restoreConvexJson(frame.messages),
    ...(metadata ? { metadata } : {}),
  };
}
