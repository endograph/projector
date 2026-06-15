import { v } from "convex/values";
import { query } from "./_generated/server";
import { restoreConvexJson } from "./convexJson";

export const getById = query({
  args: { frameId: v.id("machineFrames") },
  handler: async (ctx, { frameId }) => {
    const frame = await ctx.db.get(frameId);
    if (!frame) return null;
    return restoreFrame(frame);
  },
});

export const list = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const frames = await ctx.db
      .query("machineFrames")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
    return frames.map((frame) => restoreFrame(frame));
  },
});

function restoreFrame<T extends { messages: unknown; metadata?: unknown }>(frame: T) {
  const metadata = frame.metadata ? restoreConvexJson(frame.metadata) : undefined;
  const projectorFrameId =
    metadata &&
    typeof metadata === "object" &&
    typeof (metadata as Record<string, unknown>).projectorFrameId === "string"
      ? ((metadata as Record<string, unknown>).projectorFrameId as string)
      : undefined;
  return {
    ...frame,
    ...(projectorFrameId ? { id: projectorFrameId } : {}),
    messages: restoreConvexJson(frame.messages),
    ...(metadata ? { metadata } : {}),
  };
}
