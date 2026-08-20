import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { restoreConvexJson } from "./convexJson";

type DbCtx = MutationCtx | QueryCtx;
type FrameDoc = Doc<"frames">;
type SessionDoc = Doc<"sessions">;

const MAX_SESSION_FRAMES = 2000;

export async function listSessionFrameDocs(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
): Promise<FrameDoc[]> {
  const rows = await ctx.db
    .query("frameIndex")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .order("desc")
    .take(MAX_SESSION_FRAMES);
  return await framesForIndexRows(ctx, rows);
}

export async function getLatestSessionFrameDoc(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
): Promise<FrameDoc | null> {
  const row = await ctx.db
    .query("frameIndex")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .order("desc")
    .first();
  return row ? await ctx.db.get(row.frameId) : null;
}

export async function listSessionContextFrameDocs(
  ctx: DbCtx,
  session: SessionDoc,
): Promise<FrameDoc[]> {
  const rows = await ctx.db
    .query("frameIndex")
    .withIndex("by_session_context", (q) =>
      q.eq("sessionId", session._id).eq("contextEpoch", session.contextEpoch),
    )
    .order("desc")
    .take(MAX_SESSION_FRAMES);
  return await framesForIndexRows(ctx, rows);
}

export async function getFrameIndexForSession(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
  frameId: Id<"frames">,
) {
  return await ctx.db
    .query("frameIndex")
    .withIndex("by_session_frame", (q) =>
      q.eq("sessionId", sessionId).eq("frameId", frameId),
    )
    .first();
}

export function restoreFrame(frame: FrameDoc) {
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
    ...(frame.provenance ? { provenance: restoreConvexJson(frame.provenance) } : {}),
  };
}

async function framesForIndexRows(
  ctx: DbCtx,
  rows: Doc<"frameIndex">[],
): Promise<FrameDoc[]> {
  const frames = await Promise.all(rows.map((row) => ctx.db.get(row.frameId)));
  return frames
    .filter((frame): frame is FrameDoc => frame !== null)
    .sort(compareFrames);
}

// _creationTime, not the custom createdAt: createdAt is Date.now() with
// millisecond precision, and a generator run appends many frames in one
// millisecond — the id tiebreak is random, which scrambles history order.
// Convex guarantees _creationTime is unique per table and preserves
// insertion order within a mutation.
function compareFrames(a: FrameDoc, b: FrameDoc): number {
  return a._creationTime - b._creationTime;
}
