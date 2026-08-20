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
import {
  getFrameIndexForSession,
  getLatestSessionFrameDoc,
} from "./frameHistory";

type DbCtx = MutationCtx | QueryCtx;
type MessageDoc = Doc<"messages">;

const MAX_SESSION_MESSAGES = 2000;

const agentMessageValidator = v.object({
  id: v.id("messages"),
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
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
  frameId?: Id<"frames">;
  idempotencyKey?: string;
  streamState?: string;
  streamSeq?: number;
  widget?: string;
  card?: { title: string; source: string };
  updatedSurface?: boolean;
};

export const add = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    frameId: v.optional(v.id("frames")),
    idempotencyKey: v.optional(v.string()),
    streamState: v.optional(v.string()),
    streamSeq: v.optional(v.number()),
    widget: v.optional(v.string()),
    card: v.optional(v.object({ title: v.string(), source: v.string() })),
    updatedSurface: v.optional(v.boolean()),
  },
  returns: v.id("messages"),
  handler: (ctx, args) => addMessageInternal(ctx, args),
});

// Shared by the agent action (via the mutation) and sendCommand (directly):
// idempotent, stream-seq-guarded message upsert.
export async function addMessageInternal(
  ctx: MutationCtx,
  args: AddMessageArgs,
): Promise<Id<"messages">> {
  {
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
        const existingSeq = typeof existing.streamSeq === "number" ? existing.streamSeq : -1;
        const nextSeq = typeof args.streamSeq === "number" ? args.streamSeq : existingSeq;
        if (nextSeq < existingSeq) {
          return existing._id;
        }

        const patch: Partial<MessageDoc> = {
          content: args.content,
          frameId,
        };
        if (args.streamState !== undefined) patch.streamState = args.streamState;
        if (args.streamSeq !== undefined) patch.streamSeq = args.streamSeq;
        if (args.updatedSurface !== undefined) patch.updatedSurface = args.updatedSurface;
        await ctx.db.patch(existing._id, patch);
        await setDefaultSessionTitle(ctx, session, args.role, args.content);
        return existing._id;
      }
    }

    const messageId = await ctx.db.insert("messages", {
      role: args.role,
      content: args.content,
      frameId,
      ...(args.widget !== undefined ? { widget: args.widget } : {}),
      ...(args.card !== undefined ? { card: args.card } : {}),
      ...(args.updatedSurface !== undefined ? { updatedSurface: args.updatedSurface } : {}),
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      ...(args.streamState !== undefined ? { streamState: args.streamState } : {}),
      ...(args.streamSeq !== undefined ? { streamSeq: args.streamSeq } : {}),
      createdAt: Date.now(),
    });
    await ctx.db.insert("messageIndex", {
      sessionId: args.sessionId,
      messageId,
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
    });
    await setDefaultSessionTitle(ctx, session, args.role, args.content);

    return messageId;
  }
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

export const list = query({
  args: { sessionId: v.id("sessions") },
  returns: v.array(
    v.object({
      id: v.id("messages"),
      role: v.union(v.literal("user"), v.literal("assistant")),
      content: v.string(),
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
        createdAt: message.createdAt,
        ...(activationId !== undefined ? { activationId } : {}),
        ...(message.streamState !== undefined ? { streamState: message.streamState } : {}),
        ...(message.widget !== undefined ? { widget: message.widget } : {}),
        ...(message.card !== undefined ? { card: message.card } : {}),
        ...(message.updatedSurface !== undefined ? { updatedSurface: message.updatedSurface } : {}),
      };
    });
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
    const page = messageDocs
      .filter((message): message is MessageDoc => message !== null)
      .map((message) => ({
        id: message._id,
        role: message.role,
        content: message.content,
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
  return messages
    .filter((message): message is MessageDoc => message !== null)
    .sort((a, b) => a.createdAt - b.createdAt || a._id.localeCompare(b._id));
}
