// Prebuilt explainer turns. A marketing-page card can open the conversation
// onto a rich UI answer without waiting on the model — but the turn is not a
// special case: it lands as a real frame in the durable log, so the agent
// reads it as something it already said and the inspector shows it like any
// other exchange. `reply` is the plain-text equivalent of the widget: it is
// what the LLM sees as its own prior turn, and what old clients render.

import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { appendMachineFrameInternal } from "./sessions";
import { authorizeSessionWrite } from "./access";

const TOPICS: Record<string, { ask: string; reply: string }> = {
  subagents: {
    ask: "How do sub-agents work?",
    reply: [
      "I showed you a diagram of how sub-agents work in projector. The short version:",
      "A parent machine (the diagram showed this one, \"guide\") spawns child machines — three in the diagram, labeled plan, build, and check — each a full projector agent with its own node, states, and tools. The children don't get a copied transcript; they attach to the same durable frame log, drawn as one shared rail that all four machines write frames into. When a child finishes, there's no fragile hand-back step: its result frames are already part of the shared log, and the parent just keeps going with them in context.",
      "Delegation here is projection — each child sees the slice of state and instructions meant for it, same world, different view.",
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
    guestSecret: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, topic, ask, guestSecret }) => {
    const entry = TOPICS[topic];
    if (!entry) throw new Error(`Unknown topic "${topic}"`);
    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("Session not found");
    await authorizeSessionWrite(ctx, session, guestSecret);

    const userText = ask?.trim() || entry.ask;
    const frameId = await appendMachineFrameInternal(ctx, {
      sessionId,
      session,
      frame: {
        metadata: { type: "topic", topic },
        messages: [
          { type: "user", text: userText },
          // Assistant messages default to audience "self", which is scoped to
          // the frame's generator — and an app-authored frame has none, so the
          // reply would be invisible to the model. This one was said to the
          // whole room.
          { type: "assistant", text: entry.reply, audience: "broadcast" },
        ],
      },
    });

    // createdAt is the sort key and _id is a random tiebreak, so the two rows
    // must not share a timestamp or the reply can sort above the question.
    let at = Date.now();
    const insert = async (
      role: "user" | "assistant",
      content: string,
      widget?: string,
    ) => {
      const messageId = await ctx.db.insert("messages", {
        role,
        content,
        frameId,
        ...(widget !== undefined ? { widget } : {}),
        createdAt: at++,
        idempotencyKey: `topic:${frameId}:${role}`,
      });
      await ctx.db.insert("messageIndex", {
        sessionId,
        messageId,
        idempotencyKey: `topic:${frameId}:${role}`,
      });
    };
    await insert("user", userText);
    await insert("assistant", entry.reply, topic);

    return null;
  },
});
