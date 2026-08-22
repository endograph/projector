import { getAuthUserId } from "@convex-dev/auth/server";
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";

const historyItemValidator = v.object({
  id: v.id("sessions"),
  title: v.string(),
  createdAt: v.number(),
  lastParticipatedAt: v.number(),
});

export const listMine = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(historyItemValidator),
  handler: async (ctx, { paginationOpts }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("AUTH_REQUIRED");

    const result = await ctx.db
      .query("sessionParticipants")
      .withIndex("by_user_and_last_participated_at", (q) => q.eq("userId", userId))
      .order("desc")
      .paginate(paginationOpts);
    const sessions = await Promise.all(
      result.page.map((participation) => ctx.db.get(participation.sessionId)),
    );

    return {
      ...result,
      page: result.page.flatMap((participation, index) => {
        const session = sessions[index];
        if (!session) return [];
        return [{
          id: session._id,
          title: session.title?.trim() || "untitled conversation",
          createdAt: session._creationTime,
          lastParticipatedAt: participation.lastParticipatedAt,
        }];
      }),
    };
  },
});

// Hides a conversation from only the current user's history. The session,
// transcript, and other participants remain untouched; sending another
// message later recreates the participation edge through the normal writer.
export const removeMine = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("AUTH_REQUIRED");

    const participation = await ctx.db
      .query("sessionParticipants")
      .withIndex("by_user_and_session", (q) =>
        q.eq("userId", userId).eq("sessionId", sessionId),
      )
      .unique();
    if (participation) await ctx.db.delete(participation._id);
    return null;
  },
});

export async function recordParticipationInternal(
  ctx: MutationCtx,
  {
    userId,
    sessionId,
    participatedAt,
  }: {
    userId: Id<"users">;
    sessionId: Id<"sessions">;
    participatedAt: number;
  },
): Promise<void> {
  const existing = await ctx.db
    .query("sessionParticipants")
    .withIndex("by_user_and_session", (q) =>
      q.eq("userId", userId).eq("sessionId", sessionId),
    )
    .unique();
  if (!existing) {
    await ctx.db.insert("sessionParticipants", {
      userId,
      sessionId,
      firstParticipatedAt: participatedAt,
      lastParticipatedAt: participatedAt,
    });
    return;
  }

  const firstParticipatedAt = Math.min(existing.firstParticipatedAt, participatedAt);
  const lastParticipatedAt = Math.max(existing.lastParticipatedAt, participatedAt);
  if (
    firstParticipatedAt !== existing.firstParticipatedAt ||
    lastParticipatedAt !== existing.lastParticipatedAt
  ) {
    await ctx.db.patch(existing._id, { firstParticipatedAt, lastParticipatedAt });
  }
}
