import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const list = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
  },
});

export const add = mutation({
  args: {
    sessionId: v.id("sessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    turnId: v.optional(v.id("machineTurns")),
  },
  handler: async (ctx, { sessionId, role, content, turnId }) => {
    return await ctx.db.insert("messages", {
      sessionId,
      role,
      content,
      turnId,
      createdAt: Date.now(),
    });
  },
});
