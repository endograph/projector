import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Add a step to a turn.
 */
export const add = mutation({
  args: {
    sessionId: v.id("sessions"),
    turnId: v.id("machineTurns"),
    stepNumber: v.number(),
    yieldReason: v.string(),
    response: v.string(),
    done: v.boolean(),
    messages: v.array(v.any()),
    instance: v.any(),
    activeNodeInstructions: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("machineSteps", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

/**
 * Get steps for a turn.
 */
export const getByTurn = query({
  args: { turnId: v.id("machineTurns") },
  handler: async (ctx, { turnId }) => {
    return await ctx.db
      .query("machineSteps")
      .withIndex("by_turn", (q) => q.eq("turnId", turnId))
      .collect();
  },
});

/**
 * Get steps for current turn (for thinking indicator).
 */
export const getCurrentTurnSteps = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session?.currentTurnId) return [];

    const currentTurnId = session.currentTurnId;
    return await ctx.db
      .query("machineSteps")
      .withIndex("by_turn", (q) => q.eq("turnId", currentTurnId))
      .collect();
  },
});
