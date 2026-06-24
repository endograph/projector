import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  sessions: defineTable({
    contextEpoch: v.number(),
    familyRootSessionId: v.optional(v.id("sessions")),
    forkedFromSessionId: v.optional(v.id("sessions")),
    forkedFromFrameId: v.optional(v.id("frames")),
    syncState: v.optional(v.any()),
  })
    .index("by_family_root", ["familyRootSessionId"])
    .index("by_fork_source", ["forkedFromSessionId"]),

  frames: defineTable({
    referenceFrameId: v.optional(v.id("frames")),
    generatorId: v.optional(v.string()),
    activationId: v.optional(v.string()),
    inert: v.optional(v.boolean()),
    metadata: v.optional(v.any()),
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

  messages: defineTable({
    frameId: v.id("frames"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    createdAt: v.number(),
    // Voice mode fields
    mode: v.optional(v.union(v.literal("text"), v.literal("voice"))),
    idempotencyKey: v.optional(v.string()),
    // Streaming fields (best-effort; Convex is the durable source of truth)
    streamState: v.optional(v.union(v.literal("streaming"), v.literal("complete"), v.literal("error"))),
    streamSeq: v.optional(v.number()),
  })
    .index("by_frame", ["frameId"])
    .index("by_idempotency_key", ["idempotencyKey"])
    .index("by_frame_idempotency_key", ["frameId", "idempotencyKey"]),

  messageIndex: defineTable({
    sessionId: v.id("sessions"),
    messageId: v.id("messages"),
    idempotencyKey: v.optional(v.string()),
  })
    .index("by_session", ["sessionId"])
    .index("by_session_message", ["sessionId", "messageId"])
    .index("by_session_idempotency_key", ["sessionId", "idempotencyKey"]),

  // Ephemeral session state (processing indicators, etc.)
  sessionEphemera: defineTable({
    sessionId: v.id("sessions"),
    isProcessing: v.boolean(),
    processingStartedAt: v.optional(v.number()),
  }).index("by_session", ["sessionId"]),

  // LiveKit room state for tracking dispatched agent workers.
  agentWorkerRooms: defineTable({
    sessionId: v.id("sessions"),
    roomName: v.string(),
    createdAt: v.number(),
    // Last explicit agent dispatch created for this room (best-effort; used for de-duping dispatches).
    agentDispatchId: v.optional(v.string()),
    agentDispatchCreatedAt: v.optional(v.number()),
    // Simple in-DB lock to prevent concurrent dispatch attempts from creating duplicates.
    agentDispatchLockExpiresAt: v.optional(v.number()),
    // Reconnect bookkeeping for stale/missing workers.
    agentReconnectAttempt: v.optional(v.number()),
    agentNextDispatchAt: v.optional(v.number()),
    agentLastDispatchError: v.optional(v.string()),
    agentLastStatusAt: v.optional(v.number()),
    // Active worker lease. Only the holder may run the room's machine loop.
    agentWorkerId: v.optional(v.string()),
    agentWorkerLeaseToken: v.optional(v.string()),
    agentWorkerLeaseExpiresAt: v.optional(v.number()),
    agentWorkerHeartbeatAt: v.optional(v.number()),
  })
    .index("by_session", ["sessionId"])
    .index("by_room", ["roomName"]),
});
