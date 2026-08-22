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
  }),

  // User messages and client commands enter through this inbox and are
  // materialized by the single lease-holding runner. An item is marked settled in the same
  // mutation that persists the final frame carrying its content. Settled rows
  // double as the durable command result the client awaits.
  agentInbox: defineTable({
    sessionId: v.id("sessions"),
    // `topic` remains only so the development deployment can retain already
    // settled historical rows; no code enqueues new topic items.
    kind: v.union(v.literal("message"), v.literal("command"), v.literal("topic")),
    // Escaped (convexJson): command payloads carry client machine messages.
    payload: v.any(),
    actor: messageActorValidator,
    status: v.union(v.literal("pending"), v.literal("complete"), v.literal("error")),
    // Command execution status, for the client's awaitable promise.
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    enqueuedAt: v.number(),
  }).index("by_session_status", ["sessionId", "status"]),

  // Single-runner lease: only the holder of the live generation may append
  // work-bearing frames or make runner-originated writes. Complete inert turns
  // may append directly in one OCC-serialized mutation. Claiming increments generation,
  // so a stale runner's writes fail the fence in the mutation that would have
  // committed them. Expiry only gates claiming; the fence is the generation.
  runnerLease: defineTable({
    sessionId: v.id("sessions"),
    generation: v.number(),
    // Lease rows are permanent so generation never resets. Optional while
    // existing development rows migrate; every new claim writes it.
    active: v.optional(v.boolean()),
    expiresAt: v.number(),
    renewedAt: v.number(),
    consecutiveFailures: v.optional(v.number()),
  }).index("by_session", ["sessionId"]),

  // High-churn session metadata lives separately so message and artifact
  // writes do not invalidate the main session document queries.
  sessionEphemera: defineTable({
    sessionId: v.id("sessions"),
    lastActivityAt: v.number(),
    messageCount: v.number(),
    artifactCount: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_last_activity_at", ["lastActivityAt"]),

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
    // Stable AI SDK tool call id. Retries return this same artifact instead of
    // allocating another surface version.
    callId: v.optional(v.string()),
    frameId: v.optional(v.id("frames")),
    // The charter version that authored this artifact — the hook for an
    // LLM-led migration pass if the surface contract ever changes.
    charterVersion: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_session_kind_version", ["sessionId", "kind", "version"])
    .index("by_session_and_call_id", ["sessionId", "callId"]),

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
