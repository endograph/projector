import { v } from "convex/values";
import { query, internalQuery, internalMutation } from "./_generated/server";

/**
 * Voice Mode API - Queries and Mutations
 * =======================================
 *
 * Provides database operations for voice conversations.
 * Voice transcripts are stored as messages with mode="voice".
 *
 * Note: The getToken action is in livekitAgentActions.ts (requires Node.js runtime)
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

// Best-effort lock to ensure we attempt at most one agent dispatch per room at a time.
// This prevents duplicate LiveKit "dispatches" caused by multiple concurrent getToken() calls
// (e.g. React strict mode / reloads / multiple tabs).
export const claimAgentDispatchLock = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    lockTtlMs: v.optional(v.number()),
  },
  handler: async (ctx, { sessionId, lockTtlMs }) => {
    const voiceRoom = await ctx.db
      .query("voiceRooms")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();

    if (!voiceRoom) return null;

    const now = Date.now();
    const expiresAt = voiceRoom.agentDispatchLockExpiresAt ?? 0;
    if (expiresAt > now) return null;

    const ttl = lockTtlMs ?? 20_000;
    await ctx.db.patch(voiceRoom._id, {
      agentDispatchLockExpiresAt: now + ttl,
    });

    return {
      voiceRoomId: voiceRoom._id,
      roomName: voiceRoom.roomName,
      agentDispatchId: voiceRoom.agentDispatchId ?? null,
      agentDispatchCreatedAt: voiceRoom.agentDispatchCreatedAt ?? null,
    };
  },
});

export const releaseAgentDispatchLock = internalMutation({
  args: { voiceRoomId: v.id("voiceRooms") },
  handler: async (ctx, { voiceRoomId }) => {
    await ctx.db.patch(voiceRoomId, { agentDispatchLockExpiresAt: 0 });
  },
});

export const recordAgentDispatch = internalMutation({
  args: {
    voiceRoomId: v.id("voiceRooms"),
    agentDispatchId: v.string(),
    agentDispatchCreatedAt: v.number(),
  },
  handler: async (ctx, { voiceRoomId, agentDispatchId, agentDispatchCreatedAt }) => {
    await ctx.db.patch(voiceRoomId, { agentDispatchId, agentDispatchCreatedAt });
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

// Public query to lookup session by room name (for agent to resolve sessionId from CONVEX_URL)
export const getSessionIdByRoom = query({
  args: { roomName: v.string() },
  handler: async (ctx, { roomName }) => {
    const voiceRoom = await ctx.db
      .query("voiceRooms")
      .withIndex("by_room", (q) => q.eq("roomName", roomName))
      .first();

    if (!voiceRoom) return null;
    return voiceRoom.sessionId;
  },
});

// Combined query for agent initialization - returns session, current turn, and full history
export const getAgentInit = query({
  args: { roomName: v.string() },
  handler: async (ctx, { roomName }) => {
    // 1. Look up voice room by room name
    const voiceRoom = await ctx.db
      .query("voiceRooms")
      .withIndex("by_room", (q) => q.eq("roomName", roomName))
      .first();

    if (!voiceRoom) return null;

    const sessionId = voiceRoom.sessionId;

    // 2. Get session and current turn
    const session = await ctx.db.get(sessionId);
    if (!session?.currentTurnId) return null;

    const currentTurn = await ctx.db.get(session.currentTurnId);
    if (!currentTurn) return null;

    // 3. Get full history (ordered messages from all turns)
    const allTurns = await ctx.db
      .query("machineTurns")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();

    const turnMap = new Map(allTurns.map((t) => [t._id, t]));

    const orderedTurns: typeof allTurns = [];
    let currentId: typeof session.currentTurnId | undefined = session.currentTurnId;

    while (currentId) {
      const turn = turnMap.get(currentId);
      if (!turn) break;
      orderedTurns.unshift(turn);
      currentId = turn.parentId;
    }

    const history: unknown[] = [];
    for (const turn of orderedTurns) {
      history.push(...turn.messages);
    }

    return {
      sessionId,
      turnId: session.currentTurnId,
      instanceId: currentTurn.instanceId,
      instance: currentTurn.instance,
      displayInstance: currentTurn.displayInstance,
      history,
    };
  },
});
