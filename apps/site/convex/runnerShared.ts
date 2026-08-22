// Shared between the default-runtime inbox/lease mutations and the node
// runner action, so the action never has to import a mutation-bearing module
// for a constant — and lease helpers live here so any mutation module can
// fence itself without creating import cycles.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { escapeConvexJson } from "./convexJson";

export const LEASE_TTL_MS = 120_000;
// Runner self-limit: hand off well inside Convex's 10-minute action ceiling.
export const MAX_RUNNER_MS = 8 * 60_000;
export const MAX_CONSECUTIVE_RUNNER_FAILURES = 3;
export const RUNNER_RETRY_BASE_DELAY_MS = 1_000;

const STALE_LEASE_MESSAGE = "STALE_RUNNER_LEASE";

export function staleLeaseError(): Error {
  return new Error(STALE_LEASE_MESSAGE);
}

export function isStaleLeaseError(error: unknown): boolean {
  return String(error).includes(STALE_LEASE_MESSAGE);
}

export const inboxItemSettleValidator = v.object({
  itemId: v.id("agentInbox"),
  result: v.optional(v.any()),
  error: v.optional(v.string()),
});

export type InboxItemSettle = {
  itemId: Id<"agentInbox">;
  result?: unknown;
  error?: string;
};

export async function getRunnerLease(ctx: MutationCtx, sessionId: Id<"sessions">) {
  return await ctx.db
    .query("runnerLease")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();
}

/**
 * The fence. Every mutation a runner issues on a session's behalf calls this
 * first; a mismatched generation means a newer runner claimed the session and
 * this caller must stop — its in-memory machine is no longer the truth.
 */
export async function assertRunnerLease(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  generation: number,
): Promise<Doc<"runnerLease">> {
  const lease = await getRunnerLease(ctx, sessionId);
  // Expiry permits another runner to claim, but does not itself revoke the
  // holder. An explicit inactive state or a newer generation is the fence.
  if (!lease || lease.active === false || lease.generation !== generation) {
    throw staleLeaseError();
  }
  return lease;
}

export async function renewRunnerLease(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  generation: number,
  options: { madeProgress?: boolean } = {},
): Promise<void> {
  const lease = await assertRunnerLease(ctx, sessionId, generation);
  const now = Date.now();
  await ctx.db.patch(lease._id, {
    expiresAt: now + LEASE_TTL_MS,
    renewedAt: now,
    ...(options.madeProgress ? { consecutiveFailures: 0 } : {}),
  });
}

export async function settleInboxItems(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  settles: readonly InboxItemSettle[],
): Promise<void> {
  for (const settle of settles) {
    const item = await ctx.db.get(settle.itemId);
    if (!item || item.sessionId !== sessionId) continue;
    await ctx.db.patch(settle.itemId, {
      status: settle.error !== undefined ? "error" : "complete",
      ...(settle.result !== undefined ? { result: escapeConvexJson(settle.result) } : {}),
      ...(settle.error !== undefined ? { error: settle.error } : {}),
    });
  }
}
