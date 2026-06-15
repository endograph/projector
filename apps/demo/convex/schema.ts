import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  sessions: defineTable({
    headFrameId: v.optional(v.id("machineFrames")),
    branchRootFrameId: v.optional(v.id("machineFrames")),
    branchAncestors: v.optional(v.array(v.id("machineFrames"))), // ordered root->head
    syncState: v.optional(v.any()),
  }),

  machineFrames: defineTable({
    sessionId: v.id("sessions"),
    parentFrameId: v.optional(v.id("machineFrames")),
    branchRootFrameId: v.optional(v.id("machineFrames")),
    instanceId: v.string(),
    generatorId: v.optional(v.string()),
    runtimeInstanceId: v.optional(v.string()),
    activationId: v.optional(v.string()),
    inert: v.optional(v.boolean()),
    metadata: v.optional(v.any()),
    messages: v.array(v.any()),
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_parent", ["parentFrameId"])
    .index("by_branch", ["branchRootFrameId"]),

  projectorInstanceLog: defineTable({
    sessionId: v.id("sessions"),
    frameId: v.optional(v.id("machineFrames")),
    parentFrameId: v.optional(v.id("machineFrames")),
    message: v.any(),
    instance: v.any(),
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_frame", ["frameId"]),

  messages: defineTable({
    sessionId: v.id("sessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    frameId: v.optional(v.id("machineFrames")),
    createdAt: v.number(),
    // Voice mode fields
    mode: v.optional(v.union(v.literal("text"), v.literal("voice"))),
    idempotencyKey: v.optional(v.string()),
    // Streaming fields (best-effort; Convex is the durable source of truth)
    streamState: v.optional(v.union(v.literal("streaming"), v.literal("complete"), v.literal("error"))),
    streamSeq: v.optional(v.number()),
  })
    .index("by_session", ["sessionId"])
    .index("by_idempotency_key", ["idempotencyKey"])
    .index("by_session_idempotency_key", ["sessionId", "idempotencyKey"]),

  // Message index - denormalized mapping of messages to branches for efficient queries
  messageIndex: defineTable({
    sessionId: v.id("sessions"),
    messageId: v.id("messages"),
    branchRootFrameId: v.id("machineFrames"),
    frameId: v.optional(v.id("machineFrames")),
  })
    .index("by_branch", ["branchRootFrameId"])
    .index("by_session_branch", ["sessionId", "branchRootFrameId"])
    .index("by_message", ["messageId"]),

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
