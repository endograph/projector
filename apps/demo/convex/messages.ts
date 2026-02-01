import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id, Doc } from "./_generated/dataModel";

/**
 * Branching & Message Index
 * =========================
 *
 * Messages are associated with branches via the `messageIndex` table.
 * Each branch has a `branchRootTurnId` and the messageIndex maps
 * (messageId, branchRootTurnId) for O(1) branch message lookups.
 *
 * When a new branch is created (in machineTurns.create), all ancestor
 * messages are copied into the messageIndex for the new branch.
 * New messages are added to the index on insert.
 *
 * Fallback: when branchRootTurnId is undefined (transient time-travel
 * state before first message), we walk the turn ancestry tree.
 */

export const list = query({
  args: { sessionId: v.id("sessions") },
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
    turnId: v.optional(v.id("machineTurns")),
  },
  handler: async (ctx, { sessionId, role, content, turnId }) => {
    const messageId = await ctx.db.insert("messages", {
      sessionId,
      role,
      content,
      turnId,
      createdAt: Date.now(),
    });

    // Add to messageIndex for the current branch
    const session = await ctx.db.get(sessionId);
    if (session?.branchRootTurnId) {
      await ctx.db.insert("messageIndex", {
        messageId,
        branchRootTurnId: session.branchRootTurnId,
      });
    }

    return messageId;
  },
});

/**
 * List messages for the current branch path.
 * Uses the messageIndex for efficient lookup when branchRootTurnId is set.
 * Falls back to turn-ancestry walking when in transient time-travel state.
 */
export const listForTurnPath = query({
  args: {
    sessionId: v.id("sessions"),
    upToTurnId: v.optional(v.id("machineTurns")),
  },
  handler: async (ctx, { sessionId, upToTurnId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return [];

    // Fast path: use messageIndex when branch is established and no preview filter
    if (session.branchRootTurnId && !upToTurnId) {
      const indexEntries = await ctx.db
        .query("messageIndex")
        .withIndex("by_branch", (q) =>
          q.eq("branchRootTurnId", session.branchRootTurnId!)
        )
        .collect();

      const messages = await Promise.all(
        indexEntries.map((entry) => ctx.db.get(entry.messageId))
      );

      return messages
        .filter((msg): msg is Doc<"messages"> => msg !== null)
        .sort((a, b) => a.createdAt - b.createdAt);
    }

    // Slow path: walk turn ancestry (time-travel state or preview mode)
    const targetTurnId = upToTurnId ?? session.currentTurnId;
    if (!targetTurnId) {
      return await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect();
    }

    const ancestorTurnIds = new Set<Id<"machineTurns">>();
    let currentId: Id<"machineTurns"> | undefined = targetTurnId;

    while (currentId) {
      ancestorTurnIds.add(currentId);
      const turn: Doc<"machineTurns"> | null = await ctx.db.get(currentId);
      if (!turn) break;
      currentId = turn.parentId ?? undefined;
    }

    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();

    return allMessages.filter(
      (msg) => !msg.turnId || ancestorTurnIds.has(msg.turnId)
    );
  },
});
