import { v } from "convex/values";
import { query } from "./_generated/server";
import { restoreFrame } from "./frameHistory";

export const list = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return [];
    const rows = await ctx.db
      .query("frameIndex")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
    const frames = await Promise.all(
      rows.map(async (row) => {
        const frame = await ctx.db.get(row.frameId);
        return frame ? { ...restoreFrame(frame), contextEpoch: row.contextEpoch } : null;
      }),
    );
    return frames
      .filter((frame) => frame !== null)
      .sort((a, b) => a.createdAt - b.createdAt || a._id.localeCompare(b._id));
  },
});
