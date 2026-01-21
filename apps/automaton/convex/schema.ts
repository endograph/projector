import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Sessions table - tracks current position
  sessions: defineTable({
    currentTurnId: v.optional(v.id("machineTurns")),
  }),

  // MachineTurns table - one per runMachineToCompletion call
  machineTurns: defineTable({
    sessionId: v.id("sessions"),
    parentId: v.optional(v.id("machineTurns")),
    instanceId: v.string(),
    instance: v.any(), // SerializedInstance snapshot
    messages: v.array(v.any()), // Message[] from this turn
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_parent", ["parentId"]),

  // MachineSteps table - stores each step for debugging
  machineSteps: defineTable({
    sessionId: v.id("sessions"),
    turnId: v.id("machineTurns"),
    stepNumber: v.number(),
    yieldReason: v.string(),
    response: v.string(),
    done: v.boolean(),
    messages: v.array(v.any()),
    instance: v.any(),
    activeNodeInstructions: v.string(),
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_turn", ["turnId"]),

  // Messages table - for chat UI
  messages: defineTable({
    sessionId: v.id("sessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    turnId: v.optional(v.id("machineTurns")),
    createdAt: v.number(),
  }).index("by_session", ["sessionId"]),

  // ===== Automaton-specific tables =====

  // Reminders - scheduled actions with optional recurrence
  reminders: defineTable({
    sessionId: v.id("sessions"),
    title: v.string(),
    description: v.optional(v.string()),
    dueAt: v.optional(v.number()), // Unix timestamp
    recurrence: v.optional(
      v.object({
        type: v.union(
          v.literal("daily"),
          v.literal("weekly"),
          v.literal("monthly")
        ),
        interval: v.number(), // Every N days/weeks/months
      })
    ),
    completed: v.boolean(),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_due", ["sessionId", "dueAt"]),

  // Goals - user objectives with status
  goals: defineTable({
    sessionId: v.id("sessions"),
    title: v.string(),
    description: v.optional(v.string()),
    status: v.union(
      v.literal("active"),
      v.literal("completed"),
      v.literal("abandoned")
    ),
    deadline: v.optional(v.number()),
    milestones: v.array(
      v.object({
        id: v.string(),
        title: v.string(),
        completed: v.boolean(),
        completedAt: v.optional(v.number()),
      })
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_status", ["sessionId", "status"]),

  // Progress entries - tracked metrics over time
  progressEntries: defineTable({
    sessionId: v.id("sessions"),
    goalId: v.optional(v.id("goals")),
    metric: v.string(), // e.g., "weight", "exercise_minutes", "mood"
    value: v.number(),
    unit: v.optional(v.string()),
    notes: v.optional(v.string()),
    recordedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_metric", ["sessionId", "metric"])
    .index("by_goal", ["goalId"]),

  // Calendar events
  calendarEvents: defineTable({
    sessionId: v.id("sessions"),
    title: v.string(),
    description: v.optional(v.string()),
    startAt: v.number(),
    endAt: v.optional(v.number()),
    allDay: v.boolean(),
    location: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_start", ["sessionId", "startAt"]),

  // Data collections - flexible JSON storage
  dataCollections: defineTable({
    sessionId: v.id("sessions"),
    name: v.string(),
    schema: v.optional(v.any()), // JSON Schema for validation
    data: v.any(), // Flexible data storage
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_name", ["sessionId", "name"]),

  // Dynamic node definitions (for persistence)
  nodeDefinitions: defineTable({
    sessionId: v.id("sessions"),
    name: v.string(),
    instructions: v.string(),
    stateSchema: v.optional(v.any()), // JSON Schema
    toolRefs: v.array(v.string()), // References to charter tools
    transitionRefs: v.array(v.string()), // References to charter transitions
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_name", ["sessionId", "name"]),
});
