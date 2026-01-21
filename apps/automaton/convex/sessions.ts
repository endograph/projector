import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/**
 * Create a new session with initial turn entry.
 */
export const create = mutation({
  args: {
    instanceId: v.string(),
    instance: v.any(), // SerializedInstance
  },
  handler: async (ctx, { instanceId, instance }) => {
    // Create session first
    const sessionId = await ctx.db.insert("sessions", {
      currentTurnId: undefined,
    });

    // Create initial turn entry (no messages yet)
    const turnId = await ctx.db.insert("machineTurns", {
      sessionId,
      parentId: undefined,
      instanceId,
      instance,
      messages: [],
      createdAt: Date.now(),
    });

    // Update session to point to initial turn
    await ctx.db.patch(sessionId, { currentTurnId: turnId });

    return sessionId;
  },
});

/**
 * Get session with current turn data.
 */
export const get = query({
  args: { id: v.id("sessions") },
  handler: async (ctx, { id }) => {
    const session = await ctx.db.get(id);
    if (!session || !session.currentTurnId) return null;

    const currentTurn = await ctx.db.get(session.currentTurnId);
    if (!currentTurn) return null;

    return {
      sessionId: id,
      turnId: session.currentTurnId,
      instanceId: currentTurn.instanceId,
      instance: currentTurn.instance,
      messages: currentTurn.messages,
      createdAt: currentTurn.createdAt,
    };
  },
});

/**
 * Finalize a turn with final instance and accumulated messages.
 */
export const finalizeTurn = mutation({
  args: {
    turnId: v.id("machineTurns"),
    instance: v.any(),
    messages: v.array(v.any()),
  },
  handler: async (ctx, { turnId, instance, messages }) => {
    await ctx.db.patch(turnId, { instance, messages });
  },
});

/**
 * Get full message history by walking the parentId chain.
 */
export const getFullHistory = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session?.currentTurnId) return [];

    // Get all turn entries for this session
    const allTurns = await ctx.db
      .query("machineTurns")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();

    // Build a map for quick lookup
    const turnMap = new Map(allTurns.map((t) => [t._id, t]));

    // Walk from current back to root
    const orderedTurns: typeof allTurns = [];
    let currentId: Id<"machineTurns"> | undefined = session.currentTurnId;

    while (currentId) {
      const turn = turnMap.get(currentId);
      if (!turn) break;
      orderedTurns.unshift(turn);
      currentId = turn.parentId ?? undefined;
    }

    // Collect messages from all turns
    const messages: unknown[] = [];
    for (const turn of orderedTurns) {
      messages.push(...turn.messages);
    }

    return messages;
  },
});

/**
 * Get all turn entries for a session (for time travel/debug UI).
 */
export const getTurnTree = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return null;

    const turns = await ctx.db
      .query("machineTurns")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();

    return {
      currentTurnId: session.currentTurnId,
      turns,
    };
  },
});

/**
 * Time travel to a specific turn entry.
 */
export const timeTravel = mutation({
  args: {
    sessionId: v.id("sessions"),
    targetTurnId: v.id("machineTurns"),
  },
  handler: async (ctx, { sessionId, targetTurnId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("Session not found");

    const targetTurn = await ctx.db.get(targetTurnId);
    if (!targetTurn) throw new Error("Target turn entry not found");

    if (targetTurn.sessionId !== sessionId) {
      throw new Error("Target turn entry belongs to a different session");
    }

    await ctx.db.patch(sessionId, { currentTurnId: targetTurnId });
  },
});
