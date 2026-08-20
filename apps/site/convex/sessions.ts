import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  applyInstanceMessage,
  createMachine,
  executeCommand,
  runMachine,
  type Frame,
  type FrameDraft,
  type Instance,
  type InstanceMessage,
  type SerializedInstance,
} from "@projectors/core";
import {
  recordCommandResidue,
  type ClientMachineMessage,
  type MachineSyncState,
} from "@projectors/core/client";
import {
  createInitialSerializedInstance,
  createSiteClientSnapshot,
  hydrateSiteInstance,
  hydrateSourceInstance,
  readCardData,
  serializeSourceInstance,
  siteCharter,
} from "../src/agent/charter";
import { addMessageInternal } from "./messages";
import {
  getLatestSurfaceArtifact,
  readLegacySurface,
  recordSurfaceArtifacts,
} from "./artifacts";
import {
  ACCESS_ERROR,
  authorizeSessionWrite,
  hashGuestSecret,
  isValidGuestSecret,
  reserveAnonymousTurn as reserveAnonymousTurnForSession,
} from "./access";
import { escapeConvexJson, restoreConvexJson, stripClientSchemas } from "./convexJson";
import {
  getFrameIndexForSession,
  getLatestSessionFrameDoc,
  listSessionContextFrameDocs,
  listSessionFrameDocs,
  restoreFrame,
} from "./frameHistory";

type DbCtx = MutationCtx | QueryCtx;
type SessionDoc = Doc<"sessions">;

const MAX_INSTANCE_LOGS = 2000;

export const create = mutation({
  args: { guestSecret: v.optional(v.string()) },
  returns: v.id("sessions"),
  handler: async (ctx, { guestSecret }) => {
    const now = Date.now();
    const instance = createInitialSerializedInstance();
    const syncState = createEmptySyncState();
    const userId = await getAuthUserId(ctx);
    if (!userId && (!guestSecret || !isValidGuestSecret(guestSecret))) {
      throw new Error("Guest session requires a browser secret");
    }
    const sessionId = await ctx.db.insert("sessions", {
      contextEpoch: 0,
      syncState: escapeConvexJson(syncState),
      ...(userId
        ? { ownerUserId: userId }
        : { guestSecretHash: await hashGuestSecret(guestSecret!) }),
    });

    const frameId = await ctx.db.insert("frames", {
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
      instanceId: instance.id,
      frameId,
      message: escapeConvexJson({ type: "init" }),
      instance: escapeConvexJson(instance),
      createdAt: now,
    });

    return sessionId;
  },
});

export const rename = mutation({
  args: {
    sessionId: v.id("sessions"),
    title: v.string(),
    guestSecret: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, title, guestSecret }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("Session not found");
    await authorizeSessionWrite(ctx, session, guestSecret);
    const nextTitle = title.trim().slice(0, 80);
    if (!nextTitle) throw new Error("Title cannot be empty");
    await ctx.db.patch(sessionId, { title: nextTitle });
    return null;
  },
});

export const get = query({
  args: { sessionId: v.id("sessions") },
  returns: v.object({
    sessionId: v.id("sessions"),
    title: v.optional(v.string()),
    frameId: v.id("frames"),
    clientSnapshot: v.any(),
    syncState: v.any(),
    surface: v.union(
      v.null(),
      v.object({ version: v.number(), title: v.string(), source: v.string() }),
    ),
    anonymousTurnUsed: v.boolean(),
    workStartedAt: v.optional(v.number()),
  }),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("Session not found");

    const latestFrame = await getLatestSessionFrameDoc(ctx, sessionId);
    if (!latestFrame) throw new Error("Session has no frames");

    const latestInstance = await getLatestSerializedSource(ctx, sessionId);
    if (!latestInstance) throw new Error("Session has no instance snapshot");

    const syncState = restoreSyncState(session.syncState);
    const clientSnapshot = stripClientSchemas(
      createSiteClientSnapshot(latestInstance, syncState),
    );

    // The surface's TSX lives in the artifacts table, not machine state; the
    // legacy read keeps pre-artifacts sessions rendering from the source their
    // snapshots still carry.
    const artifact = await getLatestSurfaceArtifact(ctx, sessionId);
    const surface = artifact
      ? { version: artifact.version, title: artifact.title, source: artifact.source }
      : readLegacySurface(latestInstance);

    return {
      sessionId,
      ...(session.title !== undefined ? { title: session.title } : {}),
      frameId: latestFrame._id,
      clientSnapshot,
      syncState,
      surface,
      anonymousTurnUsed: session.anonymousTurnUsedAt !== undefined,
      ...(session.workStartedAt !== undefined ? { workStartedAt: session.workStartedAt } : {}),
    };
  },
});

export const getForAction = internalQuery({
  args: { sessionId: v.id("sessions") },
  returns: v.union(
    v.null(),
    v.object({
      sessionId: v.id("sessions"),
      frameId: v.id("frames"),
      instance: v.any(),
      syncState: v.any(),
    }),
  ),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return null;

    const latestFrame = await getLatestSessionFrameDoc(ctx, sessionId);
    if (!latestFrame) return null;

    const instance = await getLatestSerializedSource(ctx, sessionId);
    if (!instance) return null;

    return {
      sessionId,
      frameId: latestFrame._id,
      // Escaped: return values cross a Convex validation boundary, and a
      // serialized instance with a spawned child carries inline JSON Schema
      // ($-keys). The action restores it.
      instance: escapeConvexJson(instance),
      syncState: restoreSyncState(session.syncState),
    };
  },
});

// Internal + escaped: restored frames contain spawn messages whose inline
// nodes carry JSON Schema ($-keys), which Convex rejects at any function
// return boundary. Only the agent action consumes this; it restores.
export const listMachineContextFrames = internalQuery({
  args: { sessionId: v.id("sessions") },
  returns: v.array(v.any()),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return [];
    return escapeConvexJson(await getMachineContextFrames(ctx, session));
  },
});

export const listFrames = query({
  args: { sessionId: v.id("sessions") },
  returns: v.array(
    v.object({
      id: v.string(),
      createdAt: v.number(),
      generatorId: v.optional(v.string()),
      messages: v.array(v.any()),
    }),
  ),
  handler: async (ctx, { sessionId }) => {
    const frames = await listSessionFrameDocs(ctx, sessionId);
    return frames.map((frame) => {
      const restored = restoreFrame(frame);
      return {
        id: restored.id,
        createdAt: restored.createdAt,
        ...(restored.generatorId !== undefined ? { generatorId: restored.generatorId } : {}),
        messages: stripClientSchemas(restored.messages),
      };
    });
  },
});

export const appendMachineFrameSequence = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    referenceFrameId: v.optional(v.id("frames")),
    frames: v.array(v.any()),
  },
  returns: v.array(v.id("frames")),
  handler: async (ctx, { sessionId, referenceFrameId, frames }) => {
    const session = await getSessionOrThrow(ctx, sessionId);
    const frameIds = await appendMachineFrameSequenceInternal(ctx, {
      sessionId,
      session,
      referenceFrameId,
      frames: restoreConvexJson(frames) as Frame[],
    });
    // The run these frames came from is over; retiring the thinking indicator
    // in the same transaction keeps it from flickering between the stream's
    // last patch and the durable rows landing.
    if (session.workStartedAt !== undefined) {
      await ctx.db.patch(sessionId, { workStartedAt: undefined });
    }
    return frameIds;
  },
});

// Client-issued commands run against the same machine as the executor, in a
// transaction. Routine commands only write state. A command such as
// appPanePing may deliberately emit an actor message; the scheduler reconciles
// that into a work activation while still avoiding a model call in this
// mutation, then an internal action drains the activation after commit.
export const sendCommand = mutation({
  args: {
    sessionId: v.id("sessions"),
    message: v.any(),
    guestSecret: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, message, guestSecret }) => {
    const session = await getSessionOrThrow(ctx, sessionId);
    const access = await authorizeSessionWrite(ctx, session, guestSecret);
    const latestFrame = await getLatestSessionFrameDoc(ctx, sessionId);
    if (!latestFrame) throw new Error("Session has no frames");
    const serialized = await getLatestSerializedSource(ctx, sessionId);
    if (!serialized) throw new Error("Session has no instance snapshot");

    const machine = createMachine({
      id: sessionId,
      instance: hydrateSiteInstance(serialized, sessionId),
      charter: siteCharter,
      frames: await getMachineContextFrames(ctx, session),
    });
    await executeCommand(machine, restoreConvexJson(message) as ClientMachineMessage);

    const produced: Frame[] = [];
    for await (const frame of runMachine(machine, { scheduleWork: false })) {
      produced.push(frame);
    }
    if (access === "guest" && containsWorkActivation(produced)) {
      throw new Error(ACCESS_ERROR.authRequired);
    }
    if (produced.length > 0) {
      const frameIds = await appendMachineFrameSequenceInternal(ctx, {
        sessionId,
        session,
        referenceFrameId: latestFrame._id,
        frames: produced,
      });
      // Command-produced assistant messages (e.g. a postCard run as a client
      // command) enter the transcript here, mirroring the agent action's
      // persistence path.
      for (const [index, frame] of produced.entries()) {
        const frameId = frameIds[index];
        if (!frameId) continue;
        for (const [messageIndex, message] of frame.messages.entries()) {
          if (message.type !== "assistant") continue;
          if ((message as { audience?: unknown }).audience === "self") continue;
          const text = typeof message.text === "string" ? message.text : "";
          if (!text.trim()) continue;
          const card = readCardData(message);
          await addMessageInternal(ctx, {
            sessionId,
            role: "assistant",
            content: text,
            frameId,
            ...(card ? { card: { title: card.title, source: card.source } } : {}),
            idempotencyKey: `assistant:${frame.id}:${messageIndex}`,
          });
        }
      }

      if (containsWorkActivation(produced)) {
        // Same transaction as the scheduling: the moment the poke commits,
        // every subscribed client's thinking indicator starts — no waiting
        // for the model to say its first token.
        await ctx.db.patch(sessionId, { workStartedAt: Date.now() });
        await ctx.scheduler.runAfter(0, internal.agent.continueAfterCommand, {
          sessionId,
        });
      }
    }
    return null;
  },
});

export const reserveAnonymousTurn = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    guestSecret: v.string(),
    ipHash: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, guestSecret, ipHash }) => {
    const session = await getSessionOrThrow(ctx, sessionId);
    await reserveAnonymousTurnForSession(ctx, session, guestSecret, ipHash);
    return null;
  },
});

export const authorizeAuthenticatedTurn = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    guestSecret: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, guestSecret }) => {
    const session = await getSessionOrThrow(ctx, sessionId);
    const access = await authorizeSessionWrite(ctx, session, guestSecret);
    if (access !== "authenticated") throw new Error(ACCESS_ERROR.authRequired);
    return null;
  },
});

// Safety net for runs that die or produce no frames — the transactional clear
// lives in appendMachineFrameSequence.
export const clearWork = internalMutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (session?.workStartedAt !== undefined) {
      await ctx.db.patch(sessionId, { workStartedAt: undefined });
    }
    return null;
  },
});

function containsWorkActivation(frames: Frame[]): boolean {
  return frames.some((frame) =>
    frame.messages.some(
      (message) => message.type === "work" && message.kind === "activation",
    ),
  );
}

async function getSessionOrThrow(ctx: MutationCtx, sessionId: Id<"sessions">) {
  const session = await ctx.db.get(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  return session;
}

export async function appendMachineFrameInternal(
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
  const effectiveReferenceFrameId =
    referenceFrameId ?? (await getLatestSessionFrameDoc(ctx, sessionId))?._id;
  if (
    effectiveReferenceFrameId &&
    !(await getFrameIndexForSession(ctx, sessionId, effectiveReferenceFrameId))
  ) {
    throw new Error("Reference frame is not indexed for session");
  }

  const metadata =
    "id" in frame && typeof frame.id === "string"
      ? { ...(frame.metadata ?? {}), projectorFrameId: frame.id }
      : frame.metadata;
  const frameId = await ctx.db.insert("frames", {
    ...(effectiveReferenceFrameId !== undefined
      ? { referenceFrameId: effectiveReferenceFrameId }
      : {}),
    ...(frame.generatorId !== undefined ? { generatorId: frame.generatorId } : {}),
    ...(frame.activationId !== undefined ? { activationId: frame.activationId } : {}),
    ...(frame.inert !== undefined ? { inert: frame.inert } : {}),
    ...(metadata !== undefined ? { metadata: escapeConvexJson(metadata) } : {}),
    ...(frame.provenance !== undefined
      ? { provenance: escapeConvexJson(frame.provenance) }
      : {}),
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

  // Sequence-scoped on purpose: the machine emits one message per frame, so a
  // writeAppSurface's request and result arrive in different frames of the
  // same appended run.
  await recordSurfaceArtifacts(ctx, {
    sessionId,
    entries: frames.map((frame, index) => ({
      frameId: frameIds[index],
      messages: frame.messages,
    })),
  });

  return frameIds;
}

// All of one frame's instance messages fold into ONE snapshot row per source
// instance. Per-message rows share a createdAt millisecond, which makes
// "latest snapshot" ambiguous (the id tiebreak is effectively random), so a
// mid-frame snapshot could win the read and silently drop later mutations in
// the same frame — e.g. writeAppSurface's pane-open patch.
async function applyFrameInstanceMessages(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  frameId: Id<"frames">,
  messages: Frame["messages"],
): Promise<void> {
  const sources = new Map<string, Instance>();
  const applied = new Map<string, InstanceMessage[]>();

  for (const message of messages) {
    if (!isInstanceMessage(message)) continue;
    const targetInstanceId = instanceMessageTargetId(message);
    let source = [...sources.values()].find(
      (candidate) =>
        containsInstance(candidate, targetInstanceId) ||
        (message.kind === "remove" && sources.size > 0),
    );
    if (!source) {
      source =
        (await getLatestSourceForInstanceMessage(ctx, sessionId, message, targetInstanceId)) ??
        undefined;
      if (!source) {
        throw new Error(`No source instance contains target instance "${targetInstanceId}"`);
      }
      sources.set(source.id, source);
    }
    applyInstanceMessage(source, message, siteCharter);
    const messagesForSource = applied.get(source.id);
    if (messagesForSource) messagesForSource.push(message);
    else applied.set(source.id, [message]);
  }

  for (const [instanceId, source] of sources) {
    await ctx.db.insert("projectorInstanceLog", {
      sessionId,
      instanceId,
      frameId,
      message: escapeConvexJson(applied.get(instanceId) ?? []),
      instance: escapeConvexJson(serializeSourceInstance(source)),
      createdAt: Date.now(),
    });
  }
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
): Promise<Instance | null> {
  const latestLogs = await getLatestSourceLogs(ctx, sessionId);
  for (const log of latestLogs) {
    const source = hydrateSourceInstance(restoreConvexJson(log.instance) as SerializedInstance);
    if (containsInstance(source, targetInstanceId)) {
      return source;
    }
  }
  return null;
}

async function getLatestSource(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
): Promise<Instance | null> {
  const [latestLog] = await getLatestSourceLogs(ctx, sessionId);
  return latestLog
    ? hydrateSourceInstance(restoreConvexJson(latestLog.instance) as SerializedInstance)
    : null;
}

async function getLatestSerializedSource(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
): Promise<SerializedInstance | null> {
  const [latestLog] = await getLatestSourceLogs(ctx, sessionId);
  return latestLog
    ? (restoreConvexJson(latestLog.instance) as SerializedInstance)
    : null;
}

async function getLatestSourceLogs(ctx: DbCtx, sessionId: Id<"sessions">) {
  const logs = await ctx.db
    .query("projectorInstanceLog")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .order("desc")
    .take(MAX_INSTANCE_LOGS);
  const latestByInstance = new Map<string, Doc<"projectorInstanceLog">>();
  for (const log of logs.sort(compareLogAsc)) {
    latestByInstance.set(log.instanceId, log);
  }
  return [...latestByInstance.values()].sort(compareLogDesc);
}

function containsInstance(instance: Instance, targetInstanceId: string): boolean {
  if (instance.id === targetInstanceId) return true;
  return (instance.children ?? []).some((child) => containsInstance(child, targetInstanceId));
}

async function getMachineContextFrames(ctx: DbCtx, session: SessionDoc): Promise<Frame[]> {
  return (await listSessionContextFrameDocs(ctx, session)).map(restoreFrame) as Frame[];
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

  const nextSyncState = callIds.reduce(
    (state, callId) => recordCommandResidue(state, callId, { limit: 20 }),
    restoreSyncState(session.syncState),
  );
  await ctx.db.patch(sessionId, {
    syncState: escapeConvexJson(nextSyncState),
  });
}

function restoreSyncState(value: unknown): MachineSyncState {
  const restored = restoreConvexJson(value ?? createEmptySyncState()) as Partial<MachineSyncState>;
  return {
    recentCommandResidue: Array.isArray(restored.recentCommandResidue)
      ? restored.recentCommandResidue.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function createEmptySyncState(): MachineSyncState {
  return { recentCommandResidue: [] };
}

// _creationTime, not the custom createdAt: many log rows land in one
// millisecond (a generator run enqueues a frame per state write), and the
// id tiebreak is random — a mid-sequence snapshot could win "latest" and
// silently drop later writes. Convex guarantees _creationTime is unique per
// table and preserves insertion order within a mutation.
function compareLogAsc(
  a: Doc<"projectorInstanceLog">,
  b: Doc<"projectorInstanceLog">,
): number {
  return a._creationTime - b._creationTime;
}

function compareLogDesc(
  a: Doc<"projectorInstanceLog">,
  b: Doc<"projectorInstanceLog">,
): number {
  return b._creationTime - a._creationTime;
}
