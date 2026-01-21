import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Create a goal.
 */
export const create = mutation({
  args: {
    sessionId: v.id("sessions"),
    title: v.string(),
    description: v.optional(v.string()),
    deadline: v.optional(v.number()),
    milestones: v.optional(
      v.array(
        v.object({
          id: v.string(),
          title: v.string(),
          completed: v.boolean(),
          completedAt: v.optional(v.number()),
        })
      )
    ),
  },
  handler: async (ctx, { milestones, ...args }) => {
    const now = Date.now();
    return await ctx.db.insert("goals", {
      ...args,
      status: "active",
      milestones: milestones ?? [],
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * List all goals for a session.
 */
export const list = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db
      .query("goals")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
  },
});

/**
 * List active goals.
 */
export const listActive = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db
      .query("goals")
      .withIndex("by_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "active")
      )
      .collect();
  },
});

/**
 * Get a single goal.
 */
export const get = query({
  args: { id: v.id("goals") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

/**
 * Update a goal.
 */
export const update = mutation({
  args: {
    id: v.id("goals"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    deadline: v.optional(v.number()),
    status: v.optional(
      v.union(
        v.literal("active"),
        v.literal("completed"),
        v.literal("abandoned")
      )
    ),
  },
  handler: async (ctx, { id, ...updates }) => {
    const goal = await ctx.db.get(id);
    if (!goal) throw new Error("Goal not found");
    await ctx.db.patch(id, { ...updates, updatedAt: Date.now() });
  },
});

/**
 * Add a milestone to a goal.
 */
export const addMilestone = mutation({
  args: {
    goalId: v.id("goals"),
    title: v.string(),
  },
  handler: async (ctx, { goalId, title }) => {
    const goal = await ctx.db.get(goalId);
    if (!goal) throw new Error("Goal not found");

    const milestone = {
      id: crypto.randomUUID(),
      title,
      completed: false,
      completedAt: undefined,
    };

    await ctx.db.patch(goalId, {
      milestones: [...goal.milestones, milestone],
      updatedAt: Date.now(),
    });

    return milestone.id;
  },
});

/**
 * Complete a milestone.
 */
export const completeMilestone = mutation({
  args: {
    goalId: v.id("goals"),
    milestoneId: v.string(),
  },
  handler: async (ctx, { goalId, milestoneId }) => {
    const goal = await ctx.db.get(goalId);
    if (!goal) throw new Error("Goal not found");

    const milestones = goal.milestones.map((m) =>
      m.id === milestoneId
        ? { ...m, completed: true, completedAt: Date.now() }
        : m
    );

    await ctx.db.patch(goalId, {
      milestones,
      updatedAt: Date.now(),
    });

    // Check if all milestones are complete
    const allComplete = milestones.every((m) => m.completed);
    if (allComplete && milestones.length > 0) {
      await ctx.db.patch(goalId, {
        status: "completed",
        updatedAt: Date.now(),
      });
    }
  },
});

/**
 * Complete a goal.
 */
export const complete = mutation({
  args: { id: v.id("goals") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, {
      status: "completed",
      updatedAt: Date.now(),
    });
  },
});

/**
 * Abandon a goal.
 */
export const abandon = mutation({
  args: { id: v.id("goals") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, {
      status: "abandoned",
      updatedAt: Date.now(),
    });
  },
});
