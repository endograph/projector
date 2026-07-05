import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { collectSessionFramePath, getFrameIndexForSession, getLatestSessionFrameDoc } from "./frameHistory";
import { attachmentValidator, resolveAttachmentUrls } from "./attachments";

type DbCtx = MutationCtx | QueryCtx;
type MessageDoc = Doc<"messages">;

export const listForFramePath = query({
  args: {
    sessionId: v.id("sessions"),
    upToFrameId: v.optional(v.id("frames")),
  },
  handler: async (ctx, { sessionId, upToFrameId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return [];

    const latestFrame = await getLatestSessionFrameDoc(ctx, sessionId);
    const frameId = upToFrameId ?? latestFrame?._id;
    if (!frameId) return [];
    const framePath = await collectSessionFramePath(ctx, session, frameId);
    const frameIds = new Set(framePath.map((frame) => frame._id));
    const messages = await listMessagesForSession(ctx, sessionId);
    const visibleMessages = messages.filter((message) => frameIds.has(message.frameId));
    return await Promise.all(
      visibleMessages.map(async (message) => ({
        ...message,
        attachments: await resolveAttachmentUrls(ctx, message.attachments),
      })),
    );
  },
});

export const add = mutation({
  args: {
    sessionId: v.id("sessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    attachments: v.optional(v.array(attachmentValidator)),
    frameId: v.optional(v.id("frames")),
    mode: v.optional(v.union(v.literal("text"), v.literal("voice"))),
    idempotencyKey: v.optional(v.string()),
    streamState: v.optional(v.union(v.literal("streaming"), v.literal("complete"), v.literal("error"))),
    streamSeq: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");

    const latestFrame = await getLatestSessionFrameDoc(ctx, args.sessionId);
    const frameId = args.frameId ?? latestFrame?._id;
    if (!frameId) throw new Error("Session has no frames");
    const frameIndex = await getFrameIndexForSession(ctx, args.sessionId, frameId);
    if (!frameIndex) throw new Error("Message frame is not indexed for session");

    if (args.idempotencyKey) {
      const existingIndex = await ctx.db
        .query("messageIndex")
        .withIndex("by_session_idempotency_key", (q) =>
          q.eq("sessionId", args.sessionId).eq("idempotencyKey", args.idempotencyKey),
        )
        .first();
      const existing = existingIndex ? await ctx.db.get(existingIndex.messageId) : null;

      if (existing) {
        // Streaming updates can arrive out of order; never regress visible message content.
        const existingSeq = typeof existing.streamSeq === "number" ? existing.streamSeq : -1;
        const nextSeq = typeof args.streamSeq === "number" ? args.streamSeq : existingSeq;
        if (nextSeq < existingSeq) {
          return existing._id;
        }

        const patch: Partial<MessageDoc> = {
          content: args.content,
          frameId,
        };
        if (args.attachments !== undefined) patch.attachments = args.attachments;
        if (args.mode !== undefined) patch.mode = args.mode;
        if (args.streamState !== undefined) patch.streamState = args.streamState;
        if (args.streamSeq !== undefined) patch.streamSeq = args.streamSeq;
        await ctx.db.patch(existing._id, patch);
        return existing._id;
      }
    }

    const messageId = await ctx.db.insert("messages", {
      role: args.role,
      content: args.content,
      attachments: args.attachments,
      frameId,
      mode: args.mode,
      idempotencyKey: args.idempotencyKey,
      streamState: args.streamState,
      streamSeq: args.streamSeq,
      createdAt: Date.now(),
    });
    await ctx.db.insert("messageIndex", {
      sessionId: args.sessionId,
      messageId,
      idempotencyKey: args.idempotencyKey,
    });

    return messageId;
  },
});

export async function listMessagesForSession(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
): Promise<MessageDoc[]> {
  const rows = await ctx.db
    .query("messageIndex")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  const messages = await Promise.all(rows.map((row) => ctx.db.get(row.messageId)));
  return messages
    .filter((message): message is MessageDoc => message !== null)
    .sort((a, b) => a.createdAt - b.createdAt || a._id.localeCompare(b._id));
}
