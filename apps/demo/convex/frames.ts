import { v } from "convex/values";
import { query } from "./_generated/server";
import { listSessionFrameDocs, restoreFrame } from "./frameHistory";

export const list = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return [];
    const frames = await listSessionFrameDocs(ctx, sessionId);
    return frames.map(restoreFrame);
  },
});
