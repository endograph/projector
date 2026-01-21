import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

/**
 * Get a turn by its ID.
 */
export const get = query({
  args: { turnId: v.id("machineTurns") },
  handler: async (ctx, { turnId }) => {
    return await ctx.db.get(turnId);
  },
});

/**
 * List all turns for a session.
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

/**
 * Create a new turn entry (called at start of runMachine iteration).
 * Also updates session.currentTurnId to point to the new turn.
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

    // Update session to point to new turn
    await ctx.db.patch(sessionId, { currentTurnId: turnId });

    return turnId;
  },
});

/**
 * Finalize a turn with messages and final instance snapshot.
 */
export const finalize = mutation({
  args: {
    turnId: v.id("machineTurns"),
    instance: v.any(),
    messages: v.array(v.any()),
  },
  handler: async (ctx, { turnId, instance, messages }) => {
    await ctx.db.patch(turnId, { instance, messages });
  },
});
