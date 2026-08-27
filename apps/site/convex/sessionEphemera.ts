import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";

const BACKFILL_BATCH_SIZE = 10;
const MAX_ITEMS_PER_LEGACY_SESSION = 5_000;

async function summarizeSession(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  createdAt: number,
) {
  const [messages, artifacts] = await Promise.all([
    ctx.db
      .query("messageIndex")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .take(MAX_ITEMS_PER_LEGACY_SESSION + 1),
    ctx.db
      .query("artifacts")
      .withIndex("by_session_kind_version", (q) =>
        q.eq("sessionId", sessionId).eq("kind", "surface"),
      )
      .order("desc")
      .take(MAX_ITEMS_PER_LEGACY_SESSION + 1),
  ]);
  if (
    messages.length > MAX_ITEMS_PER_LEGACY_SESSION
    || artifacts.length > MAX_ITEMS_PER_LEGACY_SESSION
  ) {
    throw new Error(`Session ${sessionId} is too large for the ephemera backfill`);
  }

  return {
    lastActivityAt: Math.max(
      createdAt,
      messages[0]?._creationTime ?? 0,
      artifacts[0]?.createdAt ?? 0,
    ),
    messageCount: messages.length,
    artifactCount: artifacts.length,
  };
}

async function createSessionEphemeraFromExisting(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
) {
  const existing = await getSessionEphemera(ctx, sessionId);
  if (existing) return existing;

  const session = await ctx.db.get(sessionId);
  if (!session) throw new Error("Session not found");
  const summary = await summarizeSession(ctx, sessionId, session._creationTime);
  const ephemeraId = await ctx.db.insert("sessionEphemera", {
    sessionId,
    ...summary,
  });
  return await ctx.db.get(ephemeraId);
}

export async function initializeSessionEphemera(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  createdAt: number,
): Promise<void> {
  await ctx.db.insert("sessionEphemera", {
    sessionId,
    lastActivityAt: createdAt,
    messageCount: 0,
    artifactCount: 0,
  });
}

export async function recordSessionMessage(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  createdAt: number,
): Promise<void> {
  const existing = await getSessionEphemera(ctx, sessionId);
  if (!existing) {
    await createSessionEphemeraFromExisting(ctx, sessionId);
    return;
  }
  const ephemera = existing;
  await ctx.db.patch(ephemera._id, {
    lastActivityAt: createdAt,
    messageCount: ephemera.messageCount + 1,
  });
}

export async function recordSessionArtifacts(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  count: number,
): Promise<void> {
  if (count === 0) return;
  const existing = await getSessionEphemera(ctx, sessionId);
  if (!existing) {
    await createSessionEphemeraFromExisting(ctx, sessionId);
    return;
  }
  const ephemera = existing;
  await ctx.db.patch(ephemera._id, {
    artifactCount: ephemera.artifactCount + count,
  });
}

async function getSessionEphemera(ctx: MutationCtx, sessionId: Id<"sessions">) {
  return await ctx.db
    .query("sessionEphemera")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();
}

export const backfillExisting = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("sessions")
      .order("asc")
      .paginate({ cursor: cursor ?? null, numItems: BACKFILL_BATCH_SIZE });

    for (const session of page.page) {
      await createSessionEphemeraFromExisting(ctx, session._id);
    }

    if (!page.isDone) {
      const scheduled: Id<"_scheduled_functions"> = await ctx.scheduler.runAfter(
        0,
        internal.sessionEphemera.backfillExisting,
        { cursor: page.continueCursor },
      );
      void scheduled;
    }
    return null;
  },
});
