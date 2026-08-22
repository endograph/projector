// Prebuilt explainer turns. A marketing-page card can open the conversation
// onto a rich UI answer without waiting on the model — but the turn is not a
// special case: it lands as a real frame in the durable log, so the agent
// reads it as something it already said and the inspector shows it like any
// other exchange. `reply` is the plain-text equivalent of the widget: it is
// what the LLM sees as its own prior turn, and what old clients render.

import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { authorizeSessionWrite, consumeAnonymousTurn } from "./access";
import { addMessageInternal } from "./messages";
import { requireClientMessageId } from "./messageActor";
import { appendMachineFrameInternal } from "./sessions";

const TOPICS: Record<string, { ask: string; reply: string }> = {
  subagents: {
    ask: "How do sub-agents work?",
    reply: [
      "I showed you a diagram of how sub-agents work in projector. The short version:",
      "A parent machine (the diagram showed this one, \"guide\") spawns child machines — three in the diagram, labeled plan, build, and check — each a full projector agent with its own node, states, and tools. The children don't get a copied transcript; they attach to the same durable frame log, drawn as one shared rail that all four machines write frames into. When a child finishes, there's no fragile hand-back step: its result frames are already part of the shared log, and the parent just keeps going with them in context.",
      "Delegation here is projection — each child sees the slice of state and instructions meant for it, same world, different view.",
    ].join("\n\n"),
  },
  // Stub: the real time-travel explainer (and its widget) is still to come.
  timetravel: {
    ask: "How do time travel, branching, and replay work?",
    reply: [
      "Every session is a durable frame log — every message, state update, and unit of work lands as a frame.",
      "That makes three things cheap: rewind to any frame (time travel), fork a new session from it (branch), and re-run the log deterministically to the same state (replay).",
      "A fuller walkthrough of this is coming — ask me anything about it in the meantime.",
    ].join("\n\n"),
  },
};

export const open = mutation({
  args: {
    sessionId: v.id("sessions"),
    topic: v.string(),
    // The question as the visitor's card showed it; falls back to the
    // topic's canonical ask so the log always has a coherent user turn.
    ask: v.optional(v.string()),
    clientMessageId: v.string(),
    guestSecret: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, topic, ask, clientMessageId, guestSecret }) => {
    const entry = TOPICS[topic];
    if (!entry) throw new Error(`Unknown topic "${topic}"`);
    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("Session not found");
    const actor = await authorizeSessionWrite(ctx, session, guestSecret);
    if (actor.kind === "anonymous") await consumeAnonymousTurn(ctx, session);
    const normalizedClientMessageId = requireClientMessageId(clientMessageId);

    const userText = ask?.trim() || entry.ask;

    // This is already a complete turn, not work for the agent runner. Persist
    // one inert frame so it becomes history without scheduling generation.
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const frameId = await appendMachineFrameInternal(ctx, {
      sessionId,
      session,
      frame: {
        inert: true,
        metadata: { type: "topic", topic },
        messages: [
          {
            type: "user",
            text: userText,
            actor,
            clientMessageId: normalizedClientMessageId,
            messageId: userMessageId,
          },
          {
            type: "assistant",
            text: entry.reply,
            audience: "broadcast",
            messageId: assistantMessageId,
          },
        ],
      },
    });
    await addMessageInternal(ctx, {
      sessionId,
      role: "user",
      content: userText,
      actor,
      clientMessageId: normalizedClientMessageId,
      frameId,
      idempotencyKey: `user:${userMessageId}`,
    });
    await addMessageInternal(ctx, {
      sessionId,
      role: "assistant",
      content: entry.reply,
      widget: topic,
      frameId,
      idempotencyKey: `assistant:${assistantMessageId}`,
    });

    return null;
  },
});
