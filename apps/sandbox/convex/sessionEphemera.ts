import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const get = query({
  args: { sessionId: v.id("sessions") },
  handler: async () => ({ isProcessing: false }),
});

export const setProcessing = mutation({
  args: { sessionId: v.id("sessions"), isProcessing: v.boolean() },
  handler: async () => null,
});
