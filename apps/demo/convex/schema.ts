import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  sessions: defineTable({
    currentTurnId: v.optional(v.id("machineTurns")),
  }),

  machineTurns: defineTable({
    sessionId: v.id("sessions"),
    parentId: v.optional(v.id("machineTurns")),
    instanceId: v.string(),
    instance: v.any(),
    displayInstance: v.optional(v.any()),
    messages: v.array(v.any()),
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_parent", ["parentId"]),

  machineSteps: defineTable({
    sessionId: v.id("sessions"),
    turnId: v.id("machineTurns"),
    stepNumber: v.number(),
    yieldReason: v.string(),
    response: v.string(),
    done: v.boolean(),
    messages: v.array(v.any()),
    instance: v.any(),
    displayInstance: v.optional(v.any()),
    activeNodeInstructions: v.string(),
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_turn", ["turnId"]),

  messages: defineTable({
    sessionId: v.id("sessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    turnId: v.optional(v.id("machineTurns")),
    createdAt: v.number(),
    // Voice mode fields
    mode: v.optional(v.union(v.literal("text"), v.literal("voice"))),
    idempotencyKey: v.optional(v.string()),
  })
    .index("by_session", ["sessionId"])
    .index("by_idempotency_key", ["idempotencyKey"]),

  // Voice room state for tracking active voice sessions
  voiceRooms: defineTable({
    sessionId: v.id("sessions"),
    roomName: v.string(),
    createdAt: v.number(),
    // Last explicit agent dispatch created for this room (best-effort; used for de-duping dispatches).
    agentDispatchId: v.optional(v.string()),
    agentDispatchCreatedAt: v.optional(v.number()),
    // Simple in-DB lock to prevent concurrent dispatch attempts from creating duplicates.
    agentDispatchLockExpiresAt: v.optional(v.number()),
  })
    .index("by_session", ["sessionId"])
    .index("by_room", ["roomName"]),
});
