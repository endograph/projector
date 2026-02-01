import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Set the processing state for a session.
 * Called by the agent when processing starts/stops.
 */
export const setProcessing = mutation({
  args: {
    sessionId: v.id("sessions"),
    isProcessing: v.boolean(),
  },
  handler: async (ctx, { sessionId, isProcessing }) => {
    // Find existing ephemera for this session
    const existing = await ctx.db
      .query("sessionEphemera")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        isProcessing,
        processingStartedAt: isProcessing ? Date.now() : undefined,
      });
      return existing._id;
    }

    // Create new ephemera
    return await ctx.db.insert("sessionEphemera", {
      sessionId,
      isProcessing,
      processingStartedAt: isProcessing ? Date.now() : undefined,
    });
  },
});

/**
 * Get the current processing state for a session.
 * Used by the frontend to show/hide loading indicators.
 */
export const getProcessingState = query({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, { sessionId }) => {
    const ephemera = await ctx.db
      .query("sessionEphemera")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();

    return {
      isProcessing: ephemera?.isProcessing ?? false,
      processingStartedAt: ephemera?.processingStartedAt,
    };
  },
});
