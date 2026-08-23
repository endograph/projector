import { type Infer, v } from "convex/values";

export const messageActorValidator = v.object({
  id: v.string(),
  kind: v.union(v.literal("anonymous"), v.literal("github")),
  label: v.string(),
  profileUrl: v.optional(v.string()),
});

export type MessageActor = Infer<typeof messageActorValidator>;

// One contract for the client-generated id that reconciles optimistic rows
// with durable ones, shared by every entry point (action, topic, HTTP).
export function normalizeClientMessageId(value: string): string | null {
  const id = value.trim();
  return id.length > 0 && id.length <= 100 ? id : null;
}

export function requireClientMessageId(value: string): string {
  const id = normalizeClientMessageId(value);
  if (id === null) throw new Error("Invalid client message id");
  return id;
}
