import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

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
    displayInstance: v.optional(v.any()),
    activeNodeInstructions: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("machineSteps", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

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

export const getRecent = query({
  args: {
    sessionId: v.id("sessions"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { sessionId, limit = 20 }) => {
    const steps = await ctx.db
      .query("machineSteps")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .take(limit);
    return steps.reverse();
  },
});

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

export const getById = query({
  args: { stepId: v.id("machineSteps") },
  handler: async (ctx, { stepId }) => {
    return await ctx.db.get(stepId);
  },
});
