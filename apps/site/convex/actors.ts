import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { MessageActor } from "./messageActor";

export function anonymousActor(sessionId: Id<"sessions">): MessageActor {
  return {
    id: `anonymous:${sessionId}`,
    kind: "anonymous",
    label: "ANON",
  };
}

export function githubActor(user: Doc<"users">): MessageActor {
  // auth.ts deliberately stores GitHub's login in `name`; never use the
  // provider's human-facing display name for shared-room attribution.
  const handle = (user.name?.trim() || "user").toLowerCase();
  return {
    id: `github:${user._id}`,
    kind: "github",
    label: `@github/${handle}`,
    profileUrl: `https://github.com/${encodeURIComponent(handle)}`,
  };
}

export async function authenticatedUser(
  ctx: MutationCtx | QueryCtx,
): Promise<{ userId: Id<"users">; actor: MessageActor } | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const user = await ctx.db.get(userId);
  return user ? { userId, actor: githubActor(user) } : null;
}
