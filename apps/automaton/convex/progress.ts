import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Record a progress entry.
 */
export const record = mutation({
  args: {
    sessionId: v.id("sessions"),
    metric: v.string(),
    value: v.number(),
    unit: v.optional(v.string()),
    notes: v.optional(v.string()),
    goalId: v.optional(v.id("goals")),
    recordedAt: v.optional(v.number()),
  },
  handler: async (ctx, { recordedAt, ...args }) => {
    const now = Date.now();
    return await ctx.db.insert("progressEntries", {
      ...args,
      recordedAt: recordedAt ?? now,
      createdAt: now,
    });
  },
});

/**
 * Get progress history for a session.
 */
export const getHistory = query({
  args: {
    sessionId: v.id("sessions"),
    metric: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { sessionId, metric, limit }) => {
    let entries;
    if (metric) {
      entries = await ctx.db
        .query("progressEntries")
        .withIndex("by_metric", (q) =>
          q.eq("sessionId", sessionId).eq("metric", metric)
        )
        .order("desc")
        .collect();
    } else {
      entries = await ctx.db
        .query("progressEntries")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .order("desc")
        .collect();
    }

    if (limit) {
      entries = entries.slice(0, limit);
    }

    return entries;
  },
});

/**
 * Get progress for a specific goal.
 */
export const getByGoal = query({
  args: { goalId: v.id("goals") },
  handler: async (ctx, { goalId }) => {
    return await ctx.db
      .query("progressEntries")
      .withIndex("by_goal", (q) => q.eq("goalId", goalId))
      .order("desc")
      .collect();
  },
});

/**
 * Get aggregate stats for a metric.
 */
export const getStats = query({
  args: {
    sessionId: v.id("sessions"),
    metric: v.string(),
    days: v.optional(v.number()), // Last N days
  },
  handler: async (ctx, { sessionId, metric, days }) => {
    let entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_metric", (q) =>
        q.eq("sessionId", sessionId).eq("metric", metric)
      )
      .collect();

    if (days) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      entries = entries.filter((e) => e.recordedAt >= cutoff);
    }

    if (entries.length === 0) {
      return null;
    }

    const values = entries.map((e) => e.value);
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);

    // Sort by date for trend
    entries.sort((a, b) => a.recordedAt - b.recordedAt);
    const first = entries[0].value;
    const last = entries[entries.length - 1].value;
    const trend = last - first;

    return {
      count: entries.length,
      sum,
      avg,
      min,
      max,
      first,
      last,
      trend,
      unit: entries[0].unit,
    };
  },
});

/**
 * List all unique metrics for a session.
 */
export const listMetrics = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();

    const metrics = new Set(entries.map((e) => e.metric));
    return Array.from(metrics);
  },
});

/**
 * Delete a progress entry.
 */
export const remove = mutation({
  args: { id: v.id("progressEntries") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});
