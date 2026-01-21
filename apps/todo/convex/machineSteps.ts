import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Add a step to the machineSteps table
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

// Get all steps for a specific turn
export const getByTurn = query({
  args: { turnId: v.id("machineTurns") },
  handler: async (ctx, { turnId }) => {
    return await ctx.db
      .query("machineSteps")
      .withIndex("by_turn", (q) => q.eq("turnId", turnId))
      .order("asc")
      .collect();
  },
});

// Get recent steps for a session (for UI thinking indicator)
export const getRecent = query({
  args: {
    sessionId: v.id("sessions"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { sessionId, limit = 3 }) => {
    const steps = await ctx.db
      .query("machineSteps")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .take(limit);
    // Return in ascending order (oldest first)
    return steps.reverse();
  },
});

// Get steps for the current turn (if any)
export const getCurrentTurnSteps = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session?.currentTurnId) {
      return [];
    }
    return await ctx.db
      .query("machineSteps")
      .withIndex("by_turn", (q) => q.eq("turnId", session.currentTurnId!))
      .order("asc")
      .collect();
  },
});
