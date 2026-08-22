import { ConvexHttpClient } from "convex/browser";
import { api } from "/Users/eleven/dev/projector/apps/site/convex/_generated/api";
const client = new ConvexHttpClient("https://colorless-dachshund-479.convex.cloud");
const guestSecret = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
const sessionId = await client.mutation(api.sessions.create, { guestSecret });

// Topic turn: prebuilt, must NOT trigger a model call.
await client.mutation(api.topics.open, { sessionId, topic: "subagents", clientMessageId: crypto.randomUUID(), guestSecret });

// Unknown command: the item should settle with a failure result (client throws).
const { itemId } = await client.mutation(api.inbox.sendCommand, {
  sessionId,
  message: { type: "action", kind: "request", action: "command", name: "noSuchCommand", input: {}, callId: `x-${Date.now()}` },
  guestSecret,
});

for (let i = 0; i < 30; i++) {
  const s = await client.query(api.inbox.itemStatus, { itemId });
  if (s?.status !== "pending") { console.log("bad command settled:", JSON.stringify(s)); break; }
  await new Promise(r => setTimeout(r, 1000));
}
await new Promise(r => setTimeout(r, 4000)); // give any (wrong) model turn time to appear

const frames = await client.query(api.sessions.listFrames, { sessionId });
console.log("frames:", frames.length, "unique:", new Set(frames.map((f: any) => f.id)).size);
for (const f of frames) console.log(" ", f.id.slice(0, 20), JSON.stringify(f.messages.map((m: any) => `${m.type}${m.kind ? ":" + m.kind : ""}`)));
const messages = await client.query(api.messages.list, { sessionId });
for (const m of messages) console.log("msg:", m.role, m.widget ?? "", JSON.stringify(m.content.slice(0, 50)));
