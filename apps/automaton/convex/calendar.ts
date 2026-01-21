import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Create a calendar event.
 */
export const create = mutation({
  args: {
    sessionId: v.id("sessions"),
    title: v.string(),
    description: v.optional(v.string()),
    startAt: v.number(),
    endAt: v.optional(v.number()),
    allDay: v.optional(v.boolean()),
    location: v.optional(v.string()),
  },
  handler: async (ctx, { allDay, ...args }) => {
    const now = Date.now();
    return await ctx.db.insert("calendarEvents", {
      ...args,
      allDay: allDay ?? false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * List events for a session.
 */
export const list = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db
      .query("calendarEvents")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
  },
});

/**
 * List events in a date range.
 */
export const listInRange = query({
  args: {
    sessionId: v.id("sessions"),
    startFrom: v.number(),
    startTo: v.number(),
  },
  handler: async (ctx, { sessionId, startFrom, startTo }) => {
    const events = await ctx.db
      .query("calendarEvents")
      .withIndex("by_start", (q) => q.eq("sessionId", sessionId))
      .collect();

    return events.filter(
      (e) => e.startAt >= startFrom && e.startAt <= startTo
    );
  },
});

/**
 * List upcoming events.
 */
export const listUpcoming = query({
  args: {
    sessionId: v.id("sessions"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { sessionId, limit }) => {
    const now = Date.now();
    const events = await ctx.db
      .query("calendarEvents")
      .withIndex("by_start", (q) => q.eq("sessionId", sessionId))
      .collect();

    const upcoming = events
      .filter((e) => e.startAt >= now)
      .sort((a, b) => a.startAt - b.startAt);

    return limit ? upcoming.slice(0, limit) : upcoming;
  },
});

/**
 * Get a single event.
 */
export const get = query({
  args: { id: v.id("calendarEvents") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

/**
 * Update an event.
 */
export const update = mutation({
  args: {
    id: v.id("calendarEvents"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    startAt: v.optional(v.number()),
    endAt: v.optional(v.number()),
    allDay: v.optional(v.boolean()),
    location: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...updates }) => {
    const event = await ctx.db.get(id);
    if (!event) throw new Error("Event not found");
    await ctx.db.patch(id, { ...updates, updatedAt: Date.now() });
  },
});

/**
 * Delete an event.
 */
export const remove = mutation({
  args: { id: v.id("calendarEvents") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});
