import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Todos table - synced from agent state
  todos: defineTable({
    text: v.string(),
    completed: v.boolean(),
    createdAt: v.number(),
  }),

  // Sessions table - tracks current position
  sessions: defineTable({
    currentTurnId: v.optional(v.id("machineTurns")), // Points to latest turn entry
  }),

  // MachineTurns table - merged from sessionHistory + turns (one per runMachineToCompletion call)
  machineTurns: defineTable({
    sessionId: v.id("sessions"),
    parentId: v.optional(v.id("machineTurns")), // Previous turn entry (for branching/time-travel)
    instanceId: v.string(), // Active instance ID that handled this turn
    instance: v.any(), // SerializedInstance snapshot after this turn
    messages: v.array(v.any()), // Message[] from this turn
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_parent", ["parentId"]),

  // MachineSteps table - stores each step from runMachine for debugging
  machineSteps: defineTable({
    sessionId: v.id("sessions"),
    turnId: v.id("machineTurns"), // Which turn this step belongs to
    stepNumber: v.number(), // 1, 2, 3... within the turn
    yieldReason: v.string(), // "end_turn" | "tool_use" | "cede" | "max_tokens" | "command"
    response: v.string(), // Text response (may be empty)
    done: v.boolean(), // Was this the final step?
    messages: v.array(v.any()), // Messages from this step
    instance: v.any(), // Full serialized instance snapshot
    activeNodeInstructions: v.string(), // First ~100 chars of node instructions
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_turn", ["turnId"]),

  // Messages table - for chat UI
  messages: defineTable({
    sessionId: v.id("sessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    turnId: v.optional(v.id("machineTurns")), // Link assistant messages to their turn
    createdAt: v.number(),
  }).index("by_session", ["sessionId"]),
});
