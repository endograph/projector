import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export const create = mutation({
  args: {
    instanceId: v.string(),
    instance: v.any(),
    displayInstance: v.optional(v.any()),
  },
  handler: async (ctx, { instanceId, instance, displayInstance }) => {
    const sessionId = await ctx.db.insert("sessions", {
      currentTurnId: undefined,
    });

    const turnId = await ctx.db.insert("machineTurns", {
      sessionId,
      parentId: undefined,
      instanceId,
      instance,
      displayInstance,
      messages: [],
      createdAt: Date.now(),
    });

    await ctx.db.patch(sessionId, { currentTurnId: turnId });

    return sessionId;
  },
});

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
      displayInstance: currentTurn.displayInstance,
      messages: currentTurn.messages,
      createdAt: currentTurn.createdAt,
    };
  },
});

export const getFullHistory = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session?.currentTurnId) return [];

    const allTurns = await ctx.db
      .query("machineTurns")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();

    const turnMap = new Map(allTurns.map((t) => [t._id, t]));

    const orderedTurns: typeof allTurns = [];
    let currentId: Id<"machineTurns"> | undefined = session.currentTurnId;

    while (currentId) {
      const turn = turnMap.get(currentId);
      if (!turn) break;
      orderedTurns.unshift(turn);
      currentId = turn.parentId ?? undefined;
    }

    const messages: unknown[] = [];
    for (const turn of orderedTurns) {
      messages.push(...turn.messages);
    }

    return messages;
  },
});

export const finalizeTurn = mutation({
  args: {
    turnId: v.id("machineTurns"),
    instance: v.any(),
    displayInstance: v.optional(v.any()),
    messages: v.array(v.any()),
  },
  handler: async (ctx, { turnId, instance, displayInstance, messages }) => {
    await ctx.db.patch(turnId, { instance, displayInstance, messages });
  },
});

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

export const timeTravel = mutation({
  args: {
    sessionId: v.id("sessions"),
    targetTurnId: v.id("machineTurns"),
  },
  handler: async (ctx, { sessionId, targetTurnId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("Session not found");

    const targetTurn = await ctx.db.get(targetTurnId);
    if (!targetTurn) throw new Error("Target turn not found");

    if (targetTurn.sessionId !== sessionId) {
      throw new Error("Target turn belongs to a different session");
    }

    await ctx.db.patch(sessionId, { currentTurnId: targetTurnId });
  },
});
