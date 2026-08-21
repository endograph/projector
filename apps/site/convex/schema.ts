import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";
import { messageActorValidator } from "./messageActor";

export default defineSchema({
  ...authTables,

  sessions: defineTable({
    contextEpoch: v.number(),
    title: v.optional(v.string()),
    // Authoritative artifact selection. A new artifact updates this pointer
    // in the same transaction that inserts the immutable artifact row.
    activeSurfaceVersion: v.optional(v.number()),
    syncState: v.optional(v.any()),
    // Reads are public. Writes belong to either the anonymous browser secret
    // or the GitHub identity that claims that secret after OAuth.
    guestSecretHash: v.optional(v.string()),
    ownerUserId: v.optional(v.id("users")),
    anonymousTurnUsedAt: v.optional(v.number()),
    // Set when a client command schedules an agent wake (appPanePing), cleared
    // when the run's frames persist. Presence bookkeeping, deliberately NOT
    // machine state: the client shows the thinking indicator from it, and a
    // crashed run only ever strands a timestamp the client ages out.
    workStartedAt: v.optional(v.number()),
  }),

  // One durable membership edge per authenticated participant and session.
  // Kept separate from sessions so collaborative rooms do not grow an
  // unbounded participant array or contend on the session document.
  sessionParticipants: defineTable({
    userId: v.id("users"),
    sessionId: v.id("sessions"),
    firstParticipatedAt: v.number(),
    lastParticipatedAt: v.number(),
  })
    .index("by_user_and_session", ["userId", "sessionId"])
    .index("by_user_and_last_participated_at", ["userId", "lastParticipatedAt"]),

  frames: defineTable({
    referenceFrameId: v.optional(v.id("frames")),
    generatorId: v.optional(v.string()),
    activationId: v.optional(v.string()),
    inert: v.optional(v.boolean()),
    metadata: v.optional(v.any()),
    provenance: v.optional(v.any()),
    messages: v.array(v.any()),
    createdAt: v.number(),
  }).index("by_reference", ["referenceFrameId"]),

  frameIndex: defineTable({
    sessionId: v.id("sessions"),
    frameId: v.id("frames"),
    contextEpoch: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_session_context", ["sessionId", "contextEpoch"])
    .index("by_session_frame", ["sessionId", "frameId"]),

  projectorInstanceLog: defineTable({
    sessionId: v.id("sessions"),
    instanceId: v.string(),
    frameId: v.optional(v.id("frames")),
    message: v.any(),
    instance: v.any(),
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_session_instance", ["sessionId", "instanceId"])
    .index("by_frame", ["frameId"]),

  // Generative UI, immutable and versioned. The app surface's TSX source
  // lives here — NOT in machine state — so charter/state-schema evolution can
  // never reset it, instance snapshots stay small, and every version remains
  // recoverable (and LLM-migratable) forever. Rows are append-only.
  artifacts: defineTable({
    sessionId: v.id("sessions"),
    kind: v.literal("surface"),
    version: v.number(),
    title: v.string(),
    source: v.string(),
    frameId: v.optional(v.id("frames")),
    // The charter version that authored this artifact — the hook for an
    // LLM-led migration pass if the surface contract ever changes.
    charterVersion: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_session_kind_version", ["sessionId", "kind", "version"]),

  messages: defineTable({
    frameId: v.optional(v.id("frames")),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    actor: v.optional(messageActorValidator),
    clientMessageId: v.optional(v.string()),
    // Rich client rendering for this message: the id of a prebuilt explainer
    // widget. content stays the plain-text equivalent — it is what the LLM
    // sees as history and what renders if the widget id is unknown.
    widget: v.optional(v.string()),
    // Agent-authored chat card (postCard): TSX rendered inline by the surface
    // runtime. Frame content, not state — immutable, pinned to this turn.
    card: v.optional(v.object({ title: v.string(), source: v.string() })),
    // The turn that produced this message also wrote the app surface; the
    // transcript offers "open the app pane" at the end of the response.
    updatedSurface: v.optional(v.boolean()),
    createdAt: v.number(),
    idempotencyKey: v.optional(v.string()),
    streamState: v.optional(v.string()),
  }).index("by_frame", ["frameId"]),

  messageIndex: defineTable({
    sessionId: v.id("sessions"),
    messageId: v.id("messages"),
    idempotencyKey: v.optional(v.string()),
  })
    .index("by_session", ["sessionId"])
    .index("by_session_message", ["sessionId", "messageId"])
    .index("by_session_idempotency_key", ["sessionId", "idempotencyKey"]),

  // Ephemeral, append-only chunks for live assistant output. The messages row
  // is the stable UI identity and eventual durable value; these deltas exist
  // only while that row is streaming and are removed when its frame settles.
  messageStreamDeltas: defineTable({
    messageId: v.id("messages"),
    streamSeq: v.number(),
    text: v.string(),
  }).index("by_message_and_stream_seq", ["messageId", "streamSeq"]),
});
