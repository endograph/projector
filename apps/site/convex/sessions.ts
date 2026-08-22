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
import type { Doc, Id } from "./_generated/dataModel";
import {
  applyInstanceMessage,
  type Frame,
  type FrameDraft,
  type Instance,
  type InstanceMessage,
  type SerializedInstance,
} from "@projectors/core";
import {
  recordCommandResidue,
  type MachineSyncState,
} from "@projectors/core/client";
import {
  createInitialSerializedInstance,
  createSiteClientSnapshot,
  hydrateSourceInstance,
  serializeSourceInstance,
  siteCharter,
} from "../src/agent/charter";
import {
  getSurfaceArtifact,
  getLatestSurfaceArtifact,
  readAppSurfaceSelection,
  readLegacySurface,
} from "./artifacts";
import {
  authorizeSessionWrite,
  hashGuestSecret,
  isValidGuestSecret,
  reserveAnonymousTurn as reserveAnonymousTurnForSession,
} from "./access";
import {
  inboxItemSettleValidator,
  renewRunnerLease,
  settleInboxItems,
  type InboxItemSettle,
} from "./runnerShared";
import { initializeSessionEphemera } from "./sessionEphemera";
import { escapeConvexJson, restoreConvexJson, stripClientSchemas } from "./convexJson";
import {
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
    await initializeSessionEphemera(ctx, sessionId, now);

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
    const selection = readAppSurfaceSelection(latestInstance);
    const activeVersion = session.activeSurfaceVersion ?? selection?.activeVersion;
    const artifact = activeVersion
      ? await getSurfaceArtifact(ctx, sessionId, activeVersion)
      : await getLatestSurfaceArtifact(ctx, sessionId);
    const surface = artifact
      ? { version: artifact.version, title: artifact.title, source: artifact.source }
      : readLegacySurface(latestInstance);

    // The thinking indicator, derived rather than stored: an unprocessed inbox
    // item or a live runner lease means the agent owes this session work. The
    // client ages the timestamp out, so a crashed runner's lease row only ever
    // strands a stale number.
    const pendingItem = await ctx.db
      .query("agentInbox")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "pending"),
      )
      .first();
    const lease = await ctx.db
      .query("runnerLease")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .unique();
    const workStartedAt =
      pendingItem?._creationTime ?? (lease?.active !== false ? lease?.renewedAt : undefined);

    return {
      sessionId,
      ...(session.title !== undefined ? { title: session.title } : {}),
      frameId: latestFrame._id,
      clientSnapshot,
      syncState,
      surface,
      anonymousTurnUsed: session.anonymousTurnUsedAt !== undefined,
      ...(workStartedAt !== undefined ? { workStartedAt } : {}),
    };
  },
});

export const getForAction = internalQuery({
  args: { sessionId: v.id("sessions") },
  returns: v.union(
    v.null(),
    v.object({
      sessionId: v.id("sessions"),
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

// The runner's single durable write path for frames. The lease generation is
// the fence: a stale runner (superseded by a newer claim) throws here and
// nothing lands — no frame, no instance snapshot, no item settle. Inbox items
// settle in the same transaction as their final frame. The reference frame is
// simply the head at commit time — the lease guarantees no other frame writer
// exists, so the parent chain can never fork.
export const appendRunnerFrame = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    generation: v.number(),
    frame: v.any(),
    settleItems: v.optional(v.array(inboxItemSettleValidator)),
  },
  returns: v.id("frames"),
  handler: async (ctx, { sessionId, generation, frame, settleItems }) => {
    await renewRunnerLease(ctx, sessionId, generation, { madeProgress: true });
    const session = await getSessionOrThrow(ctx, sessionId);
    const frameId = await appendMachineFrameInternal(ctx, {
      sessionId,
      session,
      frame: restoreConvexJson(frame) as Frame,
    });
    await settleInboxItems(ctx, sessionId, (settleItems ?? []) as InboxItemSettle[]);
    return frameId;
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
  }: {
    sessionId: Id<"sessions">;
    session: SessionDoc;
    frame: (FrameDraft | Frame) & { metadata?: Record<string, unknown> };
  },
) {
  // Parent = head inside this transaction. Runner appends are lease-fenced;
  // direct non-runner appends must be inert. Convex OCC retries either writer
  // if another transaction advances the indexed head concurrently.
  const effectiveReferenceFrameId = (await getLatestSessionFrameDoc(ctx, sessionId))?._id;

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
