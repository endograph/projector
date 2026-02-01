import type { Id, Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/**
 * Shared branch-creation logic.
 *
 * Creates a new branch from the current turn:
 * 1. Walks currentTurnId → root to build branchAncestors
 * 2. Creates a branch root turn with the provided instance
 * 3. Copies messageIndex entries for all ancestor messages
 * 4. Patches the session with the new branchRootTurnId, branchAncestors, and currentTurnId
 */
export async function createBranch(
  ctx: MutationCtx,
  args: {
    sessionId: Id<"sessions">;
    session: Doc<"sessions">;
    instanceId: string;
    instance: unknown;
    displayInstance?: unknown;
  },
): Promise<{ branchRootTurnId: Id<"machineTurns">; branchAncestors: Id<"machineTurns">[] }> {
  const { sessionId, session, instanceId, instance, displayInstance } = args;

  if (!session.currentTurnId) {
    throw new Error("Session has no current turn");
  }

  // Walk currentTurnId → root to build branchAncestors
  const ancestors: Id<"machineTurns">[] = [];
  let walkId: Id<"machineTurns"> | undefined = session.currentTurnId;
  while (walkId) {
    ancestors.unshift(walkId);
    const turn: Doc<"machineTurns"> | null = await ctx.db.get(walkId);
    if (!turn) break;
    walkId = turn.parentId ?? undefined;
  }

  // Create branch root turn
  const branchRootTurnId = await ctx.db.insert("machineTurns", {
    sessionId,
    parentId: session.currentTurnId,
    instanceId,
    instance,
    displayInstance,
    messages: [],
    createdAt: Date.now(),
  });

  const branchAncestors = [...ancestors, branchRootTurnId];

  // Copy messageIndex entries for ancestor messages
  const ancestorSet = new Set(ancestors);
  const allMessages = await ctx.db
    .query("messages")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();

  for (const msg of allMessages) {
    if (!msg.turnId || ancestorSet.has(msg.turnId)) {
      await ctx.db.insert("messageIndex", {
        messageId: msg._id,
        branchRootTurnId,
      });
    }
  }

  // Update session
  await ctx.db.patch(sessionId, {
    currentTurnId: branchRootTurnId,
    branchRootTurnId,
    branchAncestors,
  });

  return { branchRootTurnId, branchAncestors };
}
