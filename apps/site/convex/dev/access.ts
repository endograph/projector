import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { env, query, type MutationCtx, type QueryCtx } from "../_generated/server";

type DbCtx = MutationCtx | QueryCtx;

const ADMIN_REQUIRED = "ADMIN_REQUIRED";
const AUTH_REQUIRED = "AUTH_REQUIRED";
const GITHUB_PROVIDER = "github";

function configuredAdminGithubIds(): Set<string> {
  return new Set(
    (env.ADMIN_GITHUB_IDS ?? "")
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

async function currentGithubAccount(
  ctx: DbCtx,
): Promise<{ user: Doc<"users">; providerAccountId: string } | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;

  const [user, account] = await Promise.all([
    ctx.db.get(userId),
    ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) =>
        q.eq("userId", userId).eq("provider", GITHUB_PROVIDER),
      )
      .unique(),
  ]);
  return user && account
    ? { user, providerAccountId: account.providerAccountId }
    : null;
}

/**
 * The one deliberately non-admin dev endpoint: authenticated users may learn
 * only whether their server-resolved GitHub identity has panel access.
 */
export const current = query({
  args: {},
  returns: v.object({ isAdmin: v.boolean() }),
  handler: async (ctx) => {
    const account = await currentGithubAccount(ctx);
    if (!account) throw new ConvexError(AUTH_REQUIRED);
    return { isAdmin: configuredAdminGithubIds().has(account.providerAccountId) };
  },
});

export async function requireAdmin(ctx: DbCtx): Promise<Doc<"users">> {
  const account = await currentGithubAccount(ctx);
  if (!account || !configuredAdminGithubIds().has(account.providerAccountId)) {
    throw new ConvexError(ADMIN_REQUIRED);
  }
  return account.user;
}
