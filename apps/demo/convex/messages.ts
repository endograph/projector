import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const list = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
  },
});

export const listForFramePath = query({
  args: {
    sessionId: v.id("sessions"),
    upToFrameId: v.optional(v.id("machineFrames")),
  },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
  },
});

export const add = mutation({
  args: {
    sessionId: v.id("sessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    frameId: v.optional(v.id("machineFrames")),
    mode: v.optional(v.union(v.literal("text"), v.literal("voice"))),
    idempotencyKey: v.optional(v.string()),
    streamState: v.optional(v.union(v.literal("streaming"), v.literal("complete"), v.literal("error"))),
    streamSeq: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.idempotencyKey) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_session_idempotency_key", (q) =>
          q.eq("sessionId", args.sessionId).eq("idempotencyKey", args.idempotencyKey),
        )
        .first();

      if (existing) {
        // Streaming updates can arrive out of order; never regress visible message content.
        const existingSeq =
          typeof existing.streamSeq === "number" ? existing.streamSeq : -1;
        const nextSeq = typeof args.streamSeq === "number" ? args.streamSeq : existingSeq;
        if (nextSeq < existingSeq) {
          return existing._id;
        }
        const patch: Partial<typeof existing> = {
          content: args.content,
        };
        if (args.frameId !== undefined) patch.frameId = args.frameId;
        if (args.mode !== undefined) patch.mode = args.mode;
        if (args.streamState !== undefined) patch.streamState = args.streamState;
        if (args.streamSeq !== undefined) patch.streamSeq = args.streamSeq;
        await ctx.db.patch(existing._id, patch);
        return existing._id;
      }
    }

    const session = await ctx.db.get(args.sessionId);
    const frameId = args.frameId ?? session?.headFrameId;
    const messageId = await ctx.db.insert("messages", {
      sessionId: args.sessionId,
      role: args.role,
      content: args.content,
      frameId,
      mode: args.mode,
      idempotencyKey: args.idempotencyKey,
      streamState: args.streamState,
      streamSeq: args.streamSeq,
      createdAt: Date.now(),
    });

    if (session?.branchRootFrameId) {
      await ctx.db.insert("messageIndex", {
        sessionId: args.sessionId,
        messageId,
        branchRootFrameId: session.branchRootFrameId,
        frameId,
      });
    }

    return messageId;
  },
});
