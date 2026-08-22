// The agent inbox and runner lease: the session's single-writer concurrency
// model. User messages and client commands are enqueued here, and one
// lease-holding runner action (agent.runSession) materializes them into frames.
// Complete prebuilt topic turns bypass work entirely as direct inert frames. The lease
// generation is a fencing token: claiming bumps it, and every runner-originated
// mutation asserts it, so a stale runner's writes fail instead of forking
// history. Expiry only gates claiming and reaping — the fence is the
// generation, never the clock.

import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ACCESS_ERROR, authorizeSessionWrite } from "./access";
import { anonymousActor } from "./actors";
import { messageActorValidator, requireClientMessageId, type MessageActor } from "./messageActor";
import { addMessageInternal } from "./messages";
import { escapeConvexJson } from "./convexJson";
import {
  LEASE_TTL_MS,
  MAX_CONSECUTIVE_RUNNER_FAILURES,
  RUNNER_RETRY_BASE_DELAY_MS,
  assertRunnerLease,
  getRunnerLease,
  inboxItemSettleValidator,
  renewRunnerLease,
  settleInboxItems,
} from "./runnerShared";

const MAX_PENDING_ITEMS = 100;

/**
 * Wakes the runner if no live lease exists. Called in the same transaction as
 * every enqueue: if a runner is active it will see the item on its next poll,
 * and OCC serializes this against releaseIfIdle so an item can never land
 * unseen between "inbox empty" and "lease released".
 */
async function ensureRunner(ctx: MutationCtx, sessionId: Id<"sessions">): Promise<void> {
  const lease = await getRunnerLease(ctx, sessionId);
  if (lease && lease.active !== false && lease.expiresAt > Date.now()) return;
  // A fresh user enqueue re-opens a circuit that stopped after repeated
  // infrastructure failures.
  if (lease && (lease.consecutiveFailures ?? 0) > 0) {
    await ctx.db.patch(lease._id, { consecutiveFailures: 0 });
  }
  await ctx.scheduler.runAfter(0, internal.agent.runSession, { sessionId });
}

async function enqueueItem(
  ctx: MutationCtx,
  {
    sessionId,
    kind,
    payload,
    actor,
  }: {
    sessionId: Id<"sessions">;
    kind: "message" | "command";
    payload: unknown;
    actor: MessageActor;
  },
): Promise<Id<"agentInbox">> {
  const itemId = await ctx.db.insert("agentInbox", {
    sessionId,
    kind,
    payload: escapeConvexJson(payload),
    actor,
    status: "pending",
    enqueuedAt: Date.now(),
  });
  await ensureRunner(ctx, sessionId);
  return itemId;
}

// ---------------------------------------------------------------------------
// Enqueue entry points
// ---------------------------------------------------------------------------

export const send = mutation({
  args: {
    sessionId: v.id("sessions"),
    text: v.string(),
    clientMessageId: v.string(),
    guestSecret: v.optional(v.string()),
  },
  returns: v.object({ itemId: v.id("agentInbox") }),
  handler: async (ctx, { sessionId, text, clientMessageId, guestSecret }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("Session not found");
    const actor = await authorizeSessionWrite(ctx, session, guestSecret);
    if (actor.kind !== "github") throw new ConvexError(ACCESS_ERROR.authRequired);
    return { itemId: await enqueueUserMessage(ctx, sessionId, text, clientMessageId, actor) };
  },
});

// The anonymous path: the HTTP action reserves the one free turn first, then
// commits the enqueue through this.
export const sendAnonymous = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    text: v.string(),
    clientMessageId: v.string(),
  },
  returns: v.object({ itemId: v.id("agentInbox") }),
  handler: async (ctx, { sessionId, text, clientMessageId }) => {
    return {
      itemId: await enqueueUserMessage(
        ctx,
        sessionId,
        text,
        clientMessageId,
        anonymousActor(sessionId),
      ),
    };
  },
});

async function enqueueUserMessage(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  text: string,
  clientMessageId: string,
  actor: MessageActor,
): Promise<Id<"agentInbox">> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Message requires text");
  const normalizedClientMessageId = requireClientMessageId(clientMessageId);

  // The transcript row lands with the enqueue so it sorts ahead of the
  // assistant's streaming rows; the runner later patches on the frameId via
  // the same idempotency key when the frame persists.
  const messageId = crypto.randomUUID();
  await addMessageInternal(ctx, {
    sessionId,
    role: "user",
    content: trimmed,
    actor,
    clientMessageId: normalizedClientMessageId,
    idempotencyKey: `user:${messageId}`,
  });

  return await enqueueItem(ctx, {
    sessionId,
    kind: "message",
    payload: { text: trimmed, messageId, clientMessageId: normalizedClientMessageId },
    actor,
  });
}

export const sendCommand = mutation({
  args: {
    sessionId: v.id("sessions"),
    message: v.any(),
    guestSecret: v.optional(v.string()),
  },
  returns: v.object({ itemId: v.id("agentInbox") }),
  handler: async (ctx, { sessionId, message, guestSecret }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("Session not found");
    const actor = await authorizeSessionWrite(ctx, session, guestSecret);
    // Anonymous surface interactions may update state, but cannot spend a
    // second model turn. Reject the only command that emits a user stimulus
    // before it enters the durable queue.
    if (
      actor.kind === "anonymous" &&
      typeof message === "object" &&
      message !== null &&
      (message as { name?: unknown }).name === "appPanePing"
    ) {
      throw new ConvexError(ACCESS_ERROR.authRequired);
    }
    return {
      itemId: await enqueueItem(ctx, { sessionId, kind: "command", payload: message, actor }),
    };
  },
});

// The client's awaitable command promise reads this. Item ids are unguessable
// capability handles; the status carries no session content beyond the
// command's own result.
export const itemStatus = query({
  args: { itemId: v.id("agentInbox") },
  returns: v.union(
    v.null(),
    v.object({
      status: v.union(v.literal("pending"), v.literal("complete"), v.literal("error")),
      result: v.optional(v.any()),
      error: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { itemId }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return null;
    return {
      status: item.status,
      ...(item.result !== undefined ? { result: item.result } : {}),
      ...(item.error !== undefined ? { error: item.error } : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// Lease lifecycle (called only by the runner action)
// ---------------------------------------------------------------------------

export const claim = internalMutation({
  args: { sessionId: v.id("sessions") },
  returns: v.union(v.null(), v.object({ generation: v.number() })),
  handler: async (ctx, { sessionId }) => {
    const now = Date.now();
    const lease = await getRunnerLease(ctx, sessionId);
    if (lease && lease.active !== false && lease.expiresAt > now) return null;
    const generation = (lease?.generation ?? 0) + 1;
    if (lease) {
      await ctx.db.patch(lease._id, {
        generation,
        active: true,
        expiresAt: now + LEASE_TTL_MS,
        renewedAt: now,
      });
    } else {
      await ctx.db.insert("runnerLease", {
        sessionId,
        generation,
        active: true,
        expiresAt: now + LEASE_TTL_MS,
        renewedAt: now,
        consecutiveFailures: 0,
      });
    }
    // Crash safety: if this runner dies without releasing, the reaper breaks
    // the stale lease and re-wakes the runner for any stranded items.
    await ctx.scheduler.runAfter(LEASE_TTL_MS + 5_000, internal.inbox.reap, {
      sessionId,
      generation,
    });
    return { generation };
  },
});

export const takePending = internalMutation({
  args: { sessionId: v.id("sessions"), generation: v.number() },
  returns: v.array(
    v.object({
      itemId: v.id("agentInbox"),
      kind: v.union(v.literal("message"), v.literal("command")),
      payload: v.any(),
      actor: messageActorValidator,
    }),
  ),
  handler: async (ctx, { sessionId, generation }) => {
    await renewRunnerLease(ctx, sessionId, generation);
    const items = await ctx.db
      .query("agentInbox")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "pending"),
      )
      .take(MAX_PENDING_ITEMS);
    const actionable = items.filter(
      (item): item is typeof item & { kind: "message" | "command" } => item.kind !== "topic",
    );
    return actionable.map((item) => ({
      itemId: item._id,
      kind: item.kind,
      payload: item.payload,
      actor: item.actor,
    }));
  },
});

// Settle items that produced no frames (a command whose materialization threw
// before any frame landed). Frame-producing settles ride appendRunnerFrame.
export const settleItems = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    generation: v.number(),
    items: v.array(inboxItemSettleValidator),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, generation, items }) => {
    await assertRunnerLease(ctx, sessionId, generation);
    await settleInboxItems(ctx, sessionId, items);
    return null;
  },
});

// The atomic exit: release only if the inbox is truly empty, in the same
// transaction as the check. Lease rows remain forever; inactive marks a clean
// release while preserving the monotonic fencing generation.
export const releaseIfIdle = internalMutation({
  args: { sessionId: v.id("sessions"), generation: v.number() },
  returns: v.object({ released: v.boolean() }),
  handler: async (ctx, { sessionId, generation }) => {
    const lease = await assertRunnerLease(ctx, sessionId, generation);
    const pending = await ctx.db
      .query("agentInbox")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "pending"),
      )
      .first();
    if (pending) {
      const now = Date.now();
      await ctx.db.patch(lease._id, { expiresAt: now + LEASE_TTL_MS, renewedAt: now });
      return { released: false };
    }
    await ctx.db.patch(lease._id, { active: false, expiresAt: 0 });
    return { released: true };
  },
});

// Failure handoff. Scheduling (rather than directly invoking another action)
// avoids call-stack recursion; a durable consecutive-failure counter and
// exponential backoff prevent deterministic failures from becoming a hot loop.
export const retryAfterFailure = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    generation: v.number(),
    error: v.string(),
  },
  returns: v.object({ retryScheduled: v.boolean(), consecutiveFailures: v.number() }),
  handler: async (ctx, { sessionId, generation, error }) => {
    const lease = await assertRunnerLease(ctx, sessionId, generation);
    const consecutiveFailures = (lease.consecutiveFailures ?? 0) + 1;
    const retryScheduled = consecutiveFailures <= MAX_CONSECUTIVE_RUNNER_FAILURES;
    await ctx.db.patch(lease._id, {
      active: false,
      expiresAt: 0,
      consecutiveFailures,
    });
    if (retryScheduled) {
      const delay = RUNNER_RETRY_BASE_DELAY_MS * 2 ** (consecutiveFailures - 1);
      await ctx.scheduler.runAfter(delay, internal.agent.runSession, { sessionId });
    } else {
      console.error("Runner retry budget exhausted", {
        sessionId,
        generation,
        consecutiveFailures,
        error,
      });
    }
    return { retryScheduled, consecutiveFailures };
  },
});

// Deadline handoff: the runner is near the action ceiling; pass the session to
// a fresh action (which claims the next generation) instead of dying mid-work.
export const handoff = internalMutation({
  args: { sessionId: v.id("sessions"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, { sessionId, generation }) => {
    const lease = await assertRunnerLease(ctx, sessionId, generation);
    await ctx.db.patch(lease._id, { active: false, expiresAt: 0 });
    await ctx.scheduler.runAfter(0, internal.agent.runSession, { sessionId });
    return null;
  },
});

export const reap = internalMutation({
  args: { sessionId: v.id("sessions"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, { sessionId, generation }) => {
    const lease = await getRunnerLease(ctx, sessionId);
    // A newer generation owns the session, or the runner exited cleanly.
    if (!lease || lease.active === false || lease.generation !== generation) return null;
    const now = Date.now();
    if (lease.expiresAt > now) {
      // Still healthy — chase the renewed expiry.
      await ctx.scheduler.runAfter(lease.expiresAt - now + 5_000, internal.inbox.reap, {
        sessionId,
        generation,
      });
      return null;
    }
    await ctx.db.patch(lease._id, { active: false, expiresAt: 0 });
    // The inbox item may already be settled while its activation is unfinished,
    // so always wake a replacement. A completed session simply no-ops.
    await ctx.scheduler.runAfter(0, internal.agent.runSession, { sessionId });
    return null;
  },
});
