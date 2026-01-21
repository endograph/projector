import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Create a new turn entry.
 */
export const create = mutation({
  args: {
    sessionId: v.id("sessions"),
    parentId: v.optional(v.id("machineTurns")),
    instanceId: v.string(),
    instance: v.any(),
  },
  handler: async (ctx, { sessionId, parentId, instanceId, instance }) => {
    const turnId = await ctx.db.insert("machineTurns", {
      sessionId,
      parentId,
      instanceId,
      instance,
      messages: [],
      createdAt: Date.now(),
    });

    // Update session pointer
    await ctx.db.patch(sessionId, { currentTurnId: turnId });

    return turnId;
  },
});

/**
 * Get a single turn by ID.
 */
export const get = query({
  args: { id: v.id("machineTurns") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

/**
 * Get all turns for a session.
 */
export const listBySession = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db
      .query("machineTurns")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
  },
});
