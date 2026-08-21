import { v } from "convex/values";
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  getFrameIndexForSession,
  getLatestSessionFrameDoc,
} from "./frameHistory";
import { anonymousActor, authenticatedUser, githubActor } from "./actors";
import { messageActorValidator, type MessageActor } from "./messageActor";
import { guestSecretMatches } from "./access";
import { recordParticipationInternal } from "./sessionParticipants";

type DbCtx = MutationCtx | QueryCtx;
type MessageDoc = Doc<"messages">;

const MAX_SESSION_MESSAGES = 2000;
// At the 250ms writer cadence this covers the full ten-minute action limit.
const MAX_STREAM_DELTAS = 4096;
// Reap abandoned streaming rows comfortably past the action time ceiling.
const STREAM_REAP_DELAY_MS = 15 * 60 * 1000;

const agentMessageValidator = v.object({
  id: v.id("messages"),
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
  actor: v.optional(messageActorValidator),
  createdAt: v.number(),
});

const agentMessagePageValidator = v.object({
  session: v.union(
    v.null(),
    v.object({
      id: v.id("sessions"),
      title: v.optional(v.string()),
      createdAt: v.number(),
    }),
  ),
  messages: v.union(v.null(), paginationResultValidator(agentMessageValidator)),
});

export type AddMessageArgs = {
  sessionId: Id<"sessions">;
  role: "user" | "assistant";
  content: string;
  actor?: MessageActor;
  clientMessageId?: string;
  frameId?: Id<"frames">;
  idempotencyKey?: string;
  streamState?: string;
  widget?: string;
  card?: { title: string; source: string };
  updatedSurface?: boolean;
};

export const add = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    actor: v.optional(messageActorValidator),
    clientMessageId: v.optional(v.string()),
    frameId: v.optional(v.id("frames")),
    idempotencyKey: v.optional(v.string()),
    streamState: v.optional(v.string()),
    widget: v.optional(v.string()),
    card: v.optional(v.object({ title: v.string(), source: v.string() })),
    updatedSurface: v.optional(v.boolean()),
  },
  returns: v.id("messages"),
  handler: (ctx, args) => addMessageInternal(ctx, args),
});

export const appendStreamDelta = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    messageKey: v.string(),
    text: v.string(),
    streamSeq: v.number(),
  },
  returns: v.id("messages"),
  handler: async (ctx, { sessionId, messageKey, text, streamSeq }) => {
    const existingIndex = await ctx.db
      .query("messageIndex")
      .withIndex("by_session_idempotency_key", (q) =>
        q.eq("sessionId", sessionId).eq("idempotencyKey", messageKey),
      )
      .first();
    const existing = existingIndex ? await ctx.db.get(existingIndex.messageId) : null;
    if (existing && existing.streamState !== "streaming") return existing._id;
    let messageId: Id<"messages">;
    if (existing) {
      messageId = existing._id;
    } else {
      messageId = await addMessageInternal(ctx, {
        sessionId,
        role: "assistant",
        content: "",
        idempotencyKey: messageKey,
        streamState: "streaming",
      });
      // The producing action can die without running any cleanup (hard
      // timeout, crash), which would strand this row streaming forever and
      // leak its deltas. Settle it after the action ceiling has safely
      // passed; a normally finished stream makes this a no-op.
      await ctx.scheduler.runAfter(STREAM_REAP_DELAY_MS, internal.messages.markStreamFailed, {
        sessionId,
        messageKey,
        state: "error",
      });
    }
    if (!text) return messageId;

    // The action's stream writer is fully serialized, so deltas arrive in
    // order; streamSeq is stored only as the deterministic sort key.
    await ctx.db.insert("messageStreamDeltas", {
      messageId,
      streamSeq,
      text,
    });
    return messageId;
  },
});

export const markStreamFailed = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    messageKey: v.string(),
    state: v.union(v.literal("cancelled"), v.literal("error")),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, messageKey, state }) => {
    const index = await ctx.db
      .query("messageIndex")
      .withIndex("by_session_idempotency_key", (q) =>
        q.eq("sessionId", sessionId).eq("idempotencyKey", messageKey),
      )
      .first();
    if (!index) return null;
    const message = await ctx.db.get(index.messageId);
    if (message?.streamState === "streaming") {
      const deltas = await ctx.db
        .query("messageStreamDeltas")
        .withIndex("by_message_and_stream_seq", (q) => q.eq("messageId", message._id))
        .order("asc")
        .take(MAX_STREAM_DELTAS);
      await ctx.db.patch(message._id, {
        content: message.content + deltas.map((delta) => delta.text).join(""),
        streamState: state,
      });
      await Promise.all(deltas.map((delta) => ctx.db.delete(delta._id)));
    }
    return null;
  },
});

// Shared by the agent action (via the mutation) and sendCommand (directly):
// idempotent message upsert keyed by messageIndex idempotency key.
export async function addMessageInternal(
  ctx: MutationCtx,
  args: AddMessageArgs,
): Promise<Id<"messages">> {
  const session = await ctx.db.get(args.sessionId);
  if (!session) throw new Error("Session not found");

  const latestFrame = await getLatestSessionFrameDoc(ctx, args.sessionId);
  const frameId = args.frameId ?? latestFrame?._id;
  if (!frameId) throw new Error("Session has no frames");
  const frameIndex = await getFrameIndexForSession(ctx, args.sessionId, frameId);
  if (!frameIndex) throw new Error("Message frame is not indexed for session");

  if (args.idempotencyKey) {
    const existingIndex = await ctx.db
      .query("messageIndex")
      .withIndex("by_session_idempotency_key", (q) =>
        q.eq("sessionId", args.sessionId).eq("idempotencyKey", args.idempotencyKey),
      )
      .first();
    const existing = existingIndex ? await ctx.db.get(existingIndex.messageId) : null;

    if (existing) {
      const patch: Partial<MessageDoc> = {
        content: args.content,
        frameId,
      };
      if (args.streamState !== undefined) patch.streamState = args.streamState;
      if (args.updatedSurface !== undefined) patch.updatedSurface = args.updatedSurface;
      if (args.widget !== undefined) patch.widget = args.widget;
      if (args.card !== undefined) patch.card = args.card;
      if (args.actor !== undefined) patch.actor = args.actor;
      if (args.clientMessageId !== undefined) patch.clientMessageId = args.clientMessageId;
      await ctx.db.patch(existing._id, patch);
      await recordMessageParticipation(
        ctx,
        args.sessionId,
        args.role,
        args.actor ?? existing.actor,
        existing.createdAt,
      );
      if (args.streamState === "complete") {
        const deltas = await ctx.db
          .query("messageStreamDeltas")
          .withIndex("by_message_and_stream_seq", (q) => q.eq("messageId", existing._id))
          .take(MAX_STREAM_DELTAS);
        await Promise.all(deltas.map((delta) => ctx.db.delete(delta._id)));
      }
      await setDefaultSessionTitle(ctx, session, args.role, args.content);
      return existing._id;
    }
  }

  const createdAt = Date.now();
  const messageId = await ctx.db.insert("messages", {
    role: args.role,
    content: args.content,
    frameId,
    ...(args.actor !== undefined ? { actor: args.actor } : {}),
    ...(args.clientMessageId !== undefined
      ? { clientMessageId: args.clientMessageId }
      : {}),
    ...(args.widget !== undefined ? { widget: args.widget } : {}),
    ...(args.card !== undefined ? { card: args.card } : {}),
    ...(args.updatedSurface !== undefined ? { updatedSurface: args.updatedSurface } : {}),
    ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
    ...(args.streamState !== undefined ? { streamState: args.streamState } : {}),
    createdAt,
  });
  await ctx.db.insert("messageIndex", {
    sessionId: args.sessionId,
    messageId,
    ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
  });
  await setDefaultSessionTitle(ctx, session, args.role, args.content);
  await recordMessageParticipation(ctx, args.sessionId, args.role, args.actor, createdAt);

  return messageId;
}

async function recordMessageParticipation(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  role: "user" | "assistant",
  actor: MessageActor | undefined,
  participatedAt: number,
): Promise<void> {
  if (role !== "user" || actor?.kind !== "github") return;
  const userId = ctx.db.normalizeId("users", actor.id.slice("github:".length));
  if (!userId) return;
  await recordParticipationInternal(ctx, { userId, sessionId, participatedAt });
}

async function setDefaultSessionTitle(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  if (role !== "user" || session.title) return;
  const title = content.trim().slice(0, 80);
  if (title) await ctx.db.patch(session._id, { title });
}

// The transcript. Live stream text and viewer identity live in their own
// queries (streamText, viewerActors) so per-delta writes and auth changes
// never invalidate this one.
export const list = query({
  args: {
    sessionId: v.id("sessions"),
  },
  returns: v.array(
    v.object({
      id: v.id("messages"),
      role: v.union(v.literal("user"), v.literal("assistant")),
      content: v.string(),
      actor: v.optional(messageActorValidator),
      clientMessageId: v.optional(v.string()),
      createdAt: v.number(),
      activationId: v.optional(v.string()),
      streamState: v.optional(v.string()),
      widget: v.optional(v.string()),
      card: v.optional(v.object({ title: v.string(), source: v.string() })),
      updatedSurface: v.optional(v.boolean()),
    }),
  ),
  handler: async (ctx, { sessionId }) => {
    const messages = await listMessagesForSession(ctx, sessionId);
    const canonicalActors = await canonicalGithubActors(ctx, messages);
    const frameIds = [
      ...new Set(
        messages.flatMap((message) => (message.frameId ? [message.frameId] : [])),
      ),
    ];
    const frames = await Promise.all(frameIds.map((frameId) => ctx.db.get(frameId)));
    const activationByFrameId = new Map(
      frames
        .filter((frame) => frame !== null)
        .map((frame) => [frame._id, frame.activationId] as const),
    );
    return messages.map((message) => {
      const activationId = message.frameId
        ? activationByFrameId.get(message.frameId)
        : undefined;
      return {
        id: message._id,
        role: message.role,
        content: message.content,
        ...(message.actor !== undefined
          ? { actor: canonicalActors.get(message.actor.id) ?? message.actor }
          : {}),
        ...(message.clientMessageId !== undefined
          ? { clientMessageId: message.clientMessageId }
          : {}),
        createdAt: message.createdAt,
        ...(activationId !== undefined ? { activationId } : {}),
        ...(message.streamState !== undefined ? { streamState: message.streamState } : {}),
        ...(message.widget !== undefined ? { widget: message.widget } : {}),
        ...(message.card !== undefined ? { card: message.card } : {}),
        ...(message.updatedSurface !== undefined
          ? { updatedSurface: message.updatedSurface }
          : {}),
      };
    });
  },
});

// Who the caller is in this session, as actor ids: their GitHub actor when
// authenticated, plus the session's anonymous actor when they own it (creator
// by guest secret, or the account that claimed it). Depends only on the
// session doc and auth state — streaming writes never invalidate it.
export const viewerActors = query({
  args: {
    sessionId: v.id("sessions"),
    guestSecret: v.optional(v.string()),
  },
  returns: v.array(v.string()),
  handler: async (ctx, { sessionId, guestSecret }) => {
    const session = await ctx.db.get(sessionId);
    const user = await authenticatedUser(ctx);
    const viewerActorIds = user ? [user.actor.id] : [];
    const ownsAnonymousActor =
      session !== null &&
      ((user !== null && session.ownerUserId === user.userId) ||
        (await guestSecretMatches(session, guestSecret)));
    if (ownsAnonymousActor) {
      viewerActorIds.push(anonymousActor(sessionId).id);
    }
    return viewerActorIds;
  },
});

// Live text for one streaming message: durable content plus the delta tail.
// Subscribed per streaming row, so each 250ms delta write invalidates only
// this small query — never the transcript.
export const streamText = query({
  args: { messageId: v.id("messages") },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get(messageId);
    if (!message || message.streamState !== "streaming") return null;
    const deltas = await ctx.db
      .query("messageStreamDeltas")
      .withIndex("by_message_and_stream_seq", (q) => q.eq("messageId", messageId))
      .order("asc")
      .take(MAX_STREAM_DELTAS);
    return message.content + deltas.map((delta) => delta.text).join("");
  },
});

// Agent-only reader for a public transcript. Deliberately requires a known
// session id: there is no session discovery or text-search surface here.
export const pageForAgent = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    paginationOpts: paginationOptsValidator,
  },
  returns: agentMessagePageValidator,
  handler: async (ctx, { sessionId, paginationOpts }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return { session: null, messages: null };

    const indexPage = await ctx.db
      .query("messageIndex")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("asc")
      .paginate(paginationOpts);
    const messageDocs = await Promise.all(
      indexPage.page.map((row) => ctx.db.get(row.messageId)),
    );
    const pageDocs = messageDocs.filter((message): message is MessageDoc => message !== null);
    const canonicalActors = await canonicalGithubActors(ctx, pageDocs);
    const page = pageDocs
      .map((message) => ({
        id: message._id,
        role: message.role,
        content: message.content,
        ...(message.actor !== undefined
          ? { actor: canonicalActors.get(message.actor.id) ?? message.actor }
          : {}),
        createdAt: message.createdAt,
      }));

    return {
      session: {
        id: session._id,
        ...(session.title !== undefined ? { title: session.title } : {}),
        createdAt: session._creationTime,
      },
      messages: { ...indexPage, page },
    };
  },
});

async function canonicalGithubActors(
  ctx: DbCtx,
  messages: readonly MessageDoc[],
): Promise<Map<string, MessageActor>> {
  const actorUserIds = new Map<string, Id<"users">>();
  for (const message of messages) {
    const actor = message.actor;
    if (actor?.kind !== "github" || actorUserIds.has(actor.id)) continue;
    const userId = ctx.db.normalizeId("users", actor.id.slice("github:".length));
    if (userId) actorUserIds.set(actor.id, userId);
  }

  const canonicalActors = new Map<string, MessageActor>();
  await Promise.all(
    [...actorUserIds].map(async ([actorId, userId]) => {
      const user = await ctx.db.get(userId);
      if (user) canonicalActors.set(actorId, githubActor(user));
    }),
  );
  return canonicalActors;
}

export async function listMessagesForSession(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
): Promise<MessageDoc[]> {
  const rows = await ctx.db
    .query("messageIndex")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .order("desc")
    .take(MAX_SESSION_MESSAGES);
  const messages = await Promise.all(rows.map((row) => ctx.db.get(row.messageId)));
  // The index query provides the authoritative insertion order. Reverse the
  // newest-first bounded page instead of re-sorting by millisecond timestamps,
  // which can collide when multiple clients send together.
  return messages.reverse().filter((message): message is MessageDoc => message !== null);
}
