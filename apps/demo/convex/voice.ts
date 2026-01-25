import { v } from "convex/values";
import { query, internalQuery, internalMutation } from "./_generated/server";

/**
 * Voice Mode API - Queries and Mutations
 * =======================================
 *
 * Provides database operations for voice conversations.
 * Voice transcripts are stored as messages with mode="voice".
 *
 * Note: The getToken action is in voiceActions.ts (requires Node.js runtime)
 */

// Internal query to get session (used by action)
export const getSession = internalQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db.get(sessionId);
  },
});

export const upsertVoiceRoom = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    roomName: v.string(),
  },
  handler: async (ctx, { sessionId, roomName }) => {
    const existing = await ctx.db
      .query("voiceRooms")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { roomName, createdAt: Date.now() });
    } else {
      await ctx.db.insert("voiceRooms", {
        sessionId,
        roomName,
        createdAt: Date.now(),
      });
    }
  },
});

// Append transcript with idempotency - used by voice agent via HTTP
export const appendTranscript = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, { sessionId, role, content, idempotencyKey }) => {
    // Check for duplicate using idempotency key
    const existing = await ctx.db
      .query("messages")
      .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", idempotencyKey))
      .first();

    if (existing) {
      // Already processed - return existing message ID
      return existing._id;
    }

    // Insert new message
    return await ctx.db.insert("messages", {
      sessionId,
      role,
      content,
      mode: "voice",
      idempotencyKey,
      createdAt: Date.now(),
    });
  },
});

// Query voice room for a session
export const getVoiceRoom = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db
      .query("voiceRooms")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
  },
});

// Lookup session by room name (for agent to resolve sessionId)
export const getSessionByRoom = internalQuery({
  args: { roomName: v.string() },
  handler: async (ctx, { roomName }) => {
    const voiceRoom = await ctx.db
      .query("voiceRooms")
      .withIndex("by_room", (q) => q.eq("roomName", roomName))
      .first();

    if (!voiceRoom) return null;
    return await ctx.db.get(voiceRoom.sessionId);
  },
});
