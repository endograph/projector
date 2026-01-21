import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Create a reminder.
 */
export const create = mutation({
  args: {
    sessionId: v.id("sessions"),
    title: v.string(),
    description: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    recurrence: v.optional(
      v.object({
        type: v.union(
          v.literal("daily"),
          v.literal("weekly"),
          v.literal("monthly")
        ),
        interval: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("reminders", {
      ...args,
      completed: false,
      completedAt: undefined,
      createdAt: Date.now(),
    });
  },
});

/**
 * List reminders for a session.
 */
export const list = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db
      .query("reminders")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
  },
});

/**
 * List pending reminders (not completed).
 */
export const listPending = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const reminders = await ctx.db
      .query("reminders")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
    return reminders.filter((r) => !r.completed);
  },
});

/**
 * Complete a reminder.
 */
export const complete = mutation({
  args: { id: v.id("reminders") },
  handler: async (ctx, { id }) => {
    const reminder = await ctx.db.get(id);
    if (!reminder) throw new Error("Reminder not found");

    await ctx.db.patch(id, {
      completed: true,
      completedAt: Date.now(),
    });

    // If it's recurring, create the next occurrence
    if (reminder.recurrence && reminder.dueAt) {
      const nextDue = calculateNextDue(reminder.dueAt, reminder.recurrence);
      await ctx.db.insert("reminders", {
        sessionId: reminder.sessionId,
        title: reminder.title,
        description: reminder.description,
        dueAt: nextDue,
        recurrence: reminder.recurrence,
        completed: false,
        completedAt: undefined,
        createdAt: Date.now(),
      });
    }
  },
});

/**
 * Cancel (delete) a reminder.
 */
export const cancel = mutation({
  args: { id: v.id("reminders") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});

/**
 * Update a reminder.
 */
export const update = mutation({
  args: {
    id: v.id("reminders"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    dueAt: v.optional(v.number()),
  },
  handler: async (ctx, { id, ...updates }) => {
    const reminder = await ctx.db.get(id);
    if (!reminder) throw new Error("Reminder not found");
    await ctx.db.patch(id, updates);
  },
});

function calculateNextDue(
  currentDue: number,
  recurrence: { type: "daily" | "weekly" | "monthly"; interval: number }
): number {
  const date = new Date(currentDue);
  switch (recurrence.type) {
    case "daily":
      date.setDate(date.getDate() + recurrence.interval);
      break;
    case "weekly":
      date.setDate(date.getDate() + recurrence.interval * 7);
      break;
    case "monthly":
      date.setMonth(date.getMonth() + recurrence.interval);
      break;
  }
  return date.getTime();
}
