import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { restoreConvexJson } from "./convexJson";

type DbCtx = MutationCtx | QueryCtx;
type FrameDoc = Doc<"frames">;
type SessionDoc = Doc<"sessions">;

export async function listSessionFrameDocs(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
): Promise<FrameDoc[]> {
  const rows = await ctx.db
    .query("frameIndex")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  return await framesForIndexRows(ctx, rows);
}

export async function getLatestSessionFrameDoc(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
): Promise<FrameDoc | null> {
  const frames = await listSessionFrameDocs(ctx, sessionId);
  return frames.at(-1) ?? null;
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
    .collect();
  return await framesForIndexRows(ctx, rows);
}

export async function collectSessionFramePath(
  ctx: DbCtx,
  session: SessionDoc,
  frameId: Id<"frames">,
): Promise<FrameDoc[]> {
  const frames = await listSessionFrameDocs(ctx, session._id);
  const targetIndex = frames.findIndex((frame) => frame._id === frameId);
  if (targetIndex < 0) {
    throw new Error("Frame is not indexed for session");
  }
  return frames.slice(0, targetIndex + 1);
}

export async function getFrameIndexForSession(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
  frameId: Id<"frames">,
) {
  return await ctx.db
    .query("frameIndex")
    .withIndex("by_session_frame", (q) => q.eq("sessionId", sessionId).eq("frameId", frameId))
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

function compareFrames(a: FrameDoc, b: FrameDoc): number {
  return a.createdAt - b.createdAt || a._id.localeCompare(b._id);
}
