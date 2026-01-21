import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Create a data collection.
 */
export const create = mutation({
  args: {
    sessionId: v.id("sessions"),
    name: v.string(),
    schema: v.optional(v.any()),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("dataCollections", {
      ...args,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Get a collection by name.
 */
export const getByName = query({
  args: {
    sessionId: v.id("sessions"),
    name: v.string(),
  },
  handler: async (ctx, { sessionId, name }) => {
    const collections = await ctx.db
      .query("dataCollections")
      .withIndex("by_name", (q) =>
        q.eq("sessionId", sessionId).eq("name", name)
      )
      .collect();
    return collections[0] ?? null;
  },
});

/**
 * List all collections for a session.
 */
export const list = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db
      .query("dataCollections")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
  },
});

/**
 * Update a collection's data.
 */
export const update = mutation({
  args: {
    id: v.id("dataCollections"),
    data: v.any(),
  },
  handler: async (ctx, { id, data }) => {
    const collection = await ctx.db.get(id);
    if (!collection) throw new Error("Collection not found");
    await ctx.db.patch(id, { data, updatedAt: Date.now() });
  },
});

/**
 * Upsert a collection - create or update by name.
 */
export const upsert = mutation({
  args: {
    sessionId: v.id("sessions"),
    name: v.string(),
    data: v.any(),
    schema: v.optional(v.any()),
  },
  handler: async (ctx, { sessionId, name, data, schema }) => {
    const existing = await ctx.db
      .query("dataCollections")
      .withIndex("by_name", (q) =>
        q.eq("sessionId", sessionId).eq("name", name)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { data, updatedAt: Date.now() });
      return existing._id;
    } else {
      const now = Date.now();
      return await ctx.db.insert("dataCollections", {
        sessionId,
        name,
        schema,
        data,
        createdAt: now,
        updatedAt: now,
      });
    }
  },
});

/**
 * Query data within a collection.
 */
export const queryData = query({
  args: {
    sessionId: v.id("sessions"),
    name: v.string(),
    path: v.optional(v.string()), // JSON path like "users.0.name"
  },
  handler: async (ctx, { sessionId, name, path }) => {
    const collection = await ctx.db
      .query("dataCollections")
      .withIndex("by_name", (q) =>
        q.eq("sessionId", sessionId).eq("name", name)
      )
      .first();

    if (!collection) return null;

    if (!path) {
      return collection.data;
    }

    // Simple path traversal
    let result = collection.data;
    const parts = path.split(".");
    for (const part of parts) {
      if (result == null) return null;
      if (typeof result === "object") {
        result = (result as Record<string, unknown>)[part];
      } else {
        return null;
      }
    }
    return result;
  },
});

/**
 * Delete a collection.
 */
export const remove = mutation({
  args: { id: v.id("dataCollections") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});

/**
 * Export a collection as JSON.
 */
export const exportData = query({
  args: { id: v.id("dataCollections") },
  handler: async (ctx, { id }) => {
    const collection = await ctx.db.get(id);
    if (!collection) return null;
    return {
      name: collection.name,
      data: collection.data,
      schema: collection.schema,
      exportedAt: Date.now(),
    };
  },
});
