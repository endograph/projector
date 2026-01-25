import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id, Doc } from "./_generated/dataModel";

/**
 * Time Travel & Branching Implementation
 * ======================================
 *
 * Messages are filtered by "turn ancestry" - we walk up the turn tree via parentId
 * and only show messages belonging to turns in that chain.
 *
 * Branching is implicit via the turn tree:
 * - Each turn has a parentId pointing to its predecessor
 * - When time-traveling back and sending a new message, a new turn branches off
 * - The original branch remains intact with its messages
 *
 * Limitations of this approach:
 * - Walking up the tree for every query is O(depth) per query
 * - No explicit branch visualization or naming
 * - Messages without turnId are shown in all branches (legacy behavior)
 *
 * TODO: Revisit this approach if we need:
 * - Named/labeled branches
 * - Branch merging
 * - More efficient ancestry queries (denormalized path field)
 * - Explicit branch management UI
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
    return await ctx.db.insert("messages", {
      sessionId,
      role,
      content,
      turnId,
      createdAt: Date.now(),
    });
  },
});

/**
 * List messages filtered by turn ancestry.
 * Only returns messages belonging to turns in the ancestry chain of the target turn.
 * This enables time travel - viewing only messages relevant to a specific point in history.
 */
export const listForTurnPath = query({
  args: {
    sessionId: v.id("sessions"),
    upToTurnId: v.optional(v.id("machineTurns")),
  },
  handler: async (ctx, { sessionId, upToTurnId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return [];

    const targetTurnId = upToTurnId ?? session.currentTurnId;
    if (!targetTurnId) {
      // No turns yet - return all messages (initial state)
      return await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect();
    }

    // Build set of ancestor turn IDs by walking up the tree
    const ancestorTurnIds = new Set<Id<"machineTurns">>();
    let currentId: Id<"machineTurns"> | undefined = targetTurnId;

    while (currentId) {
      ancestorTurnIds.add(currentId);
      const turn: Doc<"machineTurns"> | null = await ctx.db.get(currentId);
      if (!turn) break;
      currentId = turn.parentId ?? undefined;
    }

    // Get all messages and filter to turn path
    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();

    return allMessages.filter(
      (msg) => !msg.turnId || ancestorTurnIds.has(msg.turnId)
    );
  },
});
