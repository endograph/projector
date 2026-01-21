import { z } from "zod";
import type { ToolDefinition, ToolContext } from "markov-machines";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { AssemblerState, ConvexClientInterface } from "../nodes/assembler";

// Tool factory context
interface ToolFactoryContext {
  sessionId: Id<"sessions">;
  convex: ConvexClientInterface;
}

// Create tool definitions that capture the context
export function createTools(factoryCtx: ToolFactoryContext) {
  const { sessionId, convex } = factoryCtx;

  // ===== REMINDER TOOLS =====

  const scheduleReminder: ToolDefinition<
    { title: string; description?: string; dueAt?: string; recurrence?: { type: "daily" | "weekly" | "monthly"; interval: number } },
    string,
    AssemblerState
  > = {
    name: "scheduleReminder",
    description: "Schedule a new reminder with optional recurrence",
    inputSchema: z.object({
      title: z.string().describe("Title of the reminder"),
      description: z.string().optional().describe("Optional description"),
      dueAt: z.string().optional().describe("When due (ISO date or 'tomorrow', 'in 2 hours')"),
      recurrence: z.object({
        type: z.enum(["daily", "weekly", "monthly"]),
        interval: z.number().describe("Every N days/weeks/months"),
      }).optional(),
    }),
    execute: async (input) => {
      const dueAt = input.dueAt ? parseRelativeDate(input.dueAt) : undefined;
      const id = await convex.mutation(api.reminders.create, {
        sessionId,
        title: input.title,
        description: input.description,
        dueAt,
        recurrence: input.recurrence,
      });
      return `Created reminder "${input.title}" (ID: ${id})${dueAt ? ` due ${new Date(dueAt).toLocaleString()}` : ""}`;
    },
  };

  const listReminders: ToolDefinition<{ includeCompleted?: boolean }, string, AssemblerState> = {
    name: "listReminders",
    description: "List all reminders",
    inputSchema: z.object({
      includeCompleted: z.boolean().optional().describe("Include completed reminders"),
    }),
    execute: async (input) => {
      const reminders = input.includeCompleted
        ? await convex.query(api.reminders.list, { sessionId })
        : await convex.query(api.reminders.listPending, { sessionId });
      if (reminders.length === 0) return "No reminders found.";
      return reminders.map(r => {
        const status = r.completed ? "[DONE]" : "[PENDING]";
        const due = r.dueAt ? ` (due: ${new Date(r.dueAt).toLocaleString()})` : "";
        return `${status} ${r.title}${due} - ID: ${r._id}`;
      }).join("\n");
    },
  };

  const completeReminder: ToolDefinition<{ id: string }, string, AssemblerState> = {
    name: "completeReminder",
    description: "Mark a reminder as completed",
    inputSchema: z.object({ id: z.string().describe("Reminder ID") }),
    execute: async (input) => {
      await convex.mutation(api.reminders.complete, { id: input.id as Id<"reminders"> });
      return "Reminder completed.";
    },
  };

  const cancelReminder: ToolDefinition<{ id: string }, string, AssemblerState> = {
    name: "cancelReminder",
    description: "Cancel (delete) a reminder",
    inputSchema: z.object({ id: z.string().describe("Reminder ID") }),
    execute: async (input) => {
      await convex.mutation(api.reminders.cancel, { id: input.id as Id<"reminders"> });
      return "Reminder cancelled.";
    },
  };

  // ===== GOAL TOOLS =====

  const setGoal: ToolDefinition<
    { title: string; description?: string; deadline?: string; milestones?: string[] },
    string,
    AssemblerState
  > = {
    name: "setGoal",
    description: "Create a new goal with optional milestones",
    inputSchema: z.object({
      title: z.string().describe("Goal title"),
      description: z.string().optional(),
      deadline: z.string().optional().describe("Deadline (ISO date or relative)"),
      milestones: z.array(z.string()).optional().describe("Initial milestones"),
    }),
    execute: async (input) => {
      const deadline = input.deadline ? parseRelativeDate(input.deadline) : undefined;
      const milestones = input.milestones?.map(title => ({
        id: crypto.randomUUID(),
        title,
        completed: false,
        completedAt: undefined,
      }));
      const id = await convex.mutation(api.goals.create, {
        sessionId,
        title: input.title,
        description: input.description,
        deadline,
        milestones,
      });
      return `Created goal "${input.title}" (ID: ${id})`;
    },
  };

  const listGoals: ToolDefinition<{ status?: "active" | "completed" | "abandoned" | "all" }, string, AssemblerState> = {
    name: "listGoals",
    description: "List goals by status",
    inputSchema: z.object({
      status: z.enum(["active", "completed", "abandoned", "all"]).optional(),
    }),
    execute: async (input) => {
      let goals = input.status === "active" || !input.status
        ? await convex.query(api.goals.listActive, { sessionId })
        : await convex.query(api.goals.list, { sessionId });
      if (input.status && input.status !== "all" && input.status !== "active") {
        goals = goals.filter(g => g.status === input.status);
      }
      if (goals.length === 0) return `No ${input.status || "active"} goals found.`;
      return goals.map(g => {
        const complete = g.milestones.filter(m => m.completed).length;
        const total = g.milestones.length;
        const progress = total > 0 ? ` [${complete}/${total}]` : "";
        return `[${g.status.toUpperCase()}] ${g.title}${progress} - ID: ${g._id}`;
      }).join("\n");
    },
  };

  const getGoalStatus: ToolDefinition<{ id: string }, string, AssemblerState> = {
    name: "getGoalStatus",
    description: "Get detailed status of a goal",
    inputSchema: z.object({ id: z.string().describe("Goal ID") }),
    execute: async (input) => {
      const goal = await convex.query(api.goals.get, { id: input.id as Id<"goals"> });
      if (!goal) return "Goal not found.";
      const lines = [`Goal: ${goal.title}`, `Status: ${goal.status}`];
      if (goal.description) lines.push(`Description: ${goal.description}`);
      if (goal.deadline) lines.push(`Deadline: ${new Date(goal.deadline).toLocaleDateString()}`);
      if (goal.milestones.length > 0) {
        lines.push("\nMilestones:");
        goal.milestones.forEach(m => {
          lines.push(`  ${m.completed ? "[x]" : "[ ]"} ${m.title}`);
        });
      }
      return lines.join("\n");
    },
  };

  const completeMilestone: ToolDefinition<{ goalId: string; milestoneId: string }, string, AssemblerState> = {
    name: "completeMilestone",
    description: "Complete a goal milestone",
    inputSchema: z.object({
      goalId: z.string().describe("Goal ID"),
      milestoneId: z.string().describe("Milestone ID"),
    }),
    execute: async (input) => {
      await convex.mutation(api.goals.completeMilestone, {
        goalId: input.goalId as Id<"goals">,
        milestoneId: input.milestoneId,
      });
      return "Milestone completed.";
    },
  };

  const addMilestone: ToolDefinition<{ goalId: string; title: string }, string, AssemblerState> = {
    name: "addMilestone",
    description: "Add a milestone to a goal",
    inputSchema: z.object({
      goalId: z.string().describe("Goal ID"),
      title: z.string().describe("Milestone title"),
    }),
    execute: async (input) => {
      const id = await convex.mutation(api.goals.addMilestone, {
        goalId: input.goalId as Id<"goals">,
        title: input.title,
      });
      return `Added milestone "${input.title}" (ID: ${id})`;
    },
  };

  // ===== PROGRESS TOOLS =====

  const recordProgress: ToolDefinition<
    { metric: string; value: number; unit?: string; notes?: string; goalId?: string },
    string,
    AssemblerState
  > = {
    name: "recordProgress",
    description: "Record a progress metric (e.g., weight, exercise_minutes)",
    inputSchema: z.object({
      metric: z.string().describe("Metric name (e.g., 'weight', 'exercise_minutes')"),
      value: z.number().describe("Value to record"),
      unit: z.string().optional().describe("Unit (e.g., 'kg', 'minutes')"),
      notes: z.string().optional(),
      goalId: z.string().optional().describe("Associated goal ID"),
    }),
    execute: async (input) => {
      await convex.mutation(api.progress.record, {
        sessionId,
        metric: input.metric,
        value: input.value,
        unit: input.unit,
        notes: input.notes,
        goalId: input.goalId as Id<"goals"> | undefined,
      });
      return `Recorded ${input.metric}: ${input.value}${input.unit ? ` ${input.unit}` : ""}`;
    },
  };

  const getProgressHistory: ToolDefinition<{ metric?: string; limit?: number }, string, AssemblerState> = {
    name: "getProgressHistory",
    description: "View progress history",
    inputSchema: z.object({
      metric: z.string().optional().describe("Filter by metric"),
      limit: z.number().optional().describe("Max entries"),
    }),
    execute: async (input) => {
      const entries = await convex.query(api.progress.getHistory, {
        sessionId,
        metric: input.metric,
        limit: input.limit,
      });
      if (entries.length === 0) return "No progress entries found.";
      return entries.map(e => {
        const date = new Date(e.recordedAt).toLocaleDateString();
        return `[${date}] ${e.metric}: ${e.value}${e.unit ? ` ${e.unit}` : ""}`;
      }).join("\n");
    },
  };

  const getProgressStats: ToolDefinition<{ metric: string; days?: number }, string, AssemblerState> = {
    name: "getProgressStats",
    description: "Get statistics for a metric",
    inputSchema: z.object({
      metric: z.string().describe("Metric name"),
      days: z.number().optional().describe("Last N days"),
    }),
    execute: async (input) => {
      const stats = await convex.query(api.progress.getStats, {
        sessionId,
        metric: input.metric,
        days: input.days,
      });
      if (!stats) return `No data for "${input.metric}".`;
      const unit = stats.unit || "";
      return `Stats for "${input.metric}":\n- Entries: ${stats.count}\n- Average: ${stats.avg.toFixed(2)}${unit}\n- Range: ${stats.min}${unit} - ${stats.max}${unit}\n- Trend: ${stats.trend >= 0 ? "+" : ""}${stats.trend.toFixed(2)}${unit}`;
    },
  };

  const listMetrics: ToolDefinition<Record<string, never>, string, AssemblerState> = {
    name: "listMetrics",
    description: "List all tracked metrics",
    inputSchema: z.object({}),
    execute: async () => {
      const metrics = await convex.query(api.progress.listMetrics, { sessionId });
      if (metrics.length === 0) return "No metrics tracked yet.";
      return `Tracked metrics:\n${metrics.map(m => `- ${m}`).join("\n")}`;
    },
  };

  // ===== CALENDAR TOOLS =====

  const createEvent: ToolDefinition<
    { title: string; startAt: string; endAt?: string; description?: string; location?: string; allDay?: boolean },
    string,
    AssemblerState
  > = {
    name: "createEvent",
    description: "Create a calendar event",
    inputSchema: z.object({
      title: z.string(),
      startAt: z.string().describe("Start time (ISO or 'tomorrow at 3pm')"),
      endAt: z.string().optional().describe("End time or duration ('1 hour')"),
      description: z.string().optional(),
      location: z.string().optional(),
      allDay: z.boolean().optional(),
    }),
    execute: async (input) => {
      const startAt = parseRelativeDate(input.startAt);
      let endAt: number | undefined;
      if (input.endAt) {
        const durMatch = input.endAt.match(/^(\d+)\s*(hour|minute|h|m)/i);
        if (durMatch) {
          const amt = parseInt(durMatch[1]);
          endAt = startAt + amt * (durMatch[2].startsWith("h") ? 3600000 : 60000);
        } else {
          endAt = parseRelativeDate(input.endAt);
        }
      }
      const id = await convex.mutation(api.calendar.create, {
        sessionId,
        title: input.title,
        startAt,
        endAt,
        description: input.description,
        location: input.location,
        allDay: input.allDay,
      });
      return `Created event "${input.title}" at ${new Date(startAt).toLocaleString()} (ID: ${id})`;
    },
  };

  const listEvents: ToolDefinition<{ upcoming?: boolean; limit?: number }, string, AssemblerState> = {
    name: "listEvents",
    description: "List calendar events",
    inputSchema: z.object({
      upcoming: z.boolean().optional().describe("Only upcoming"),
      limit: z.number().optional(),
    }),
    execute: async (input) => {
      let events = input.upcoming
        ? await convex.query(api.calendar.listUpcoming, { sessionId, limit: input.limit })
        : await convex.query(api.calendar.list, { sessionId });
      if (input.limit && !input.upcoming) events = events.slice(0, input.limit);
      if (events.length === 0) return "No events found.";
      return events.map(e => {
        const when = e.allDay
          ? new Date(e.startAt).toLocaleDateString()
          : new Date(e.startAt).toLocaleString();
        return `- ${e.title} (${when}) - ID: ${e._id}`;
      }).join("\n");
    },
  };

  // ===== DATA TOOLS =====

  const collectData: ToolDefinition<{ collection: string; data: unknown; merge?: boolean }, string, AssemblerState> = {
    name: "collectData",
    description: "Store data in a named collection",
    inputSchema: z.object({
      collection: z.string().describe("Collection name"),
      data: z.any().describe("Data to store"),
      merge: z.boolean().optional().describe("Merge with existing"),
    }),
    execute: async (input) => {
      await convex.mutation(api.data.upsert, {
        sessionId,
        name: input.collection,
        data: input.data,
      });
      return `Stored data in collection "${input.collection}".`;
    },
  };

  const queryData: ToolDefinition<{ collection: string; path?: string }, string, AssemblerState> = {
    name: "queryData",
    description: "Query data from a collection",
    inputSchema: z.object({
      collection: z.string(),
      path: z.string().optional().describe("JSON path (e.g., 'users.0.name')"),
    }),
    execute: async (input) => {
      const result = await convex.query(api.data.queryData, {
        sessionId,
        name: input.collection,
        path: input.path,
      });
      if (result === null) return `Collection "${input.collection}" not found.`;
      return `Result:\n${JSON.stringify(result, null, 2)}`;
    },
  };

  const listCollections: ToolDefinition<Record<string, never>, string, AssemblerState> = {
    name: "listCollections",
    description: "List all data collections",
    inputSchema: z.object({}),
    execute: async () => {
      const collections = await convex.query(api.data.list, { sessionId });
      if (collections.length === 0) return "No collections found.";
      return collections.map(c => `- ${c.name}`).join("\n");
    },
  };

  return {
    scheduleReminder,
    listReminders,
    completeReminder,
    cancelReminder,
    setGoal,
    listGoals,
    getGoalStatus,
    completeMilestone,
    addMilestone,
    recordProgress,
    getProgressHistory,
    getProgressStats,
    listMetrics,
    createEvent,
    listEvents,
    collectData,
    queryData,
    listCollections,
  };
}

// Helper to parse relative dates
function parseRelativeDate(input: string): number {
  const now = new Date();
  const lower = input.toLowerCase().trim();

  // Try ISO first
  const iso = new Date(input);
  if (!isNaN(iso.getTime())) return iso.getTime();

  if (lower === "tomorrow") {
    now.setDate(now.getDate() + 1);
    now.setHours(9, 0, 0, 0);
    return now.getTime();
  }

  if (lower === "next week") {
    now.setDate(now.getDate() + 7);
    now.setHours(9, 0, 0, 0);
    return now.getTime();
  }

  // "in X hours/minutes/days"
  const inMatch = lower.match(/^in\s+(\d+)\s+(hour|minute|day|week)s?$/);
  if (inMatch) {
    const amt = parseInt(inMatch[1]);
    switch (inMatch[2]) {
      case "minute": now.setMinutes(now.getMinutes() + amt); break;
      case "hour": now.setHours(now.getHours() + amt); break;
      case "day": now.setDate(now.getDate() + amt); break;
      case "week": now.setDate(now.getDate() + amt * 7); break;
    }
    return now.getTime();
  }

  // "tomorrow at 3pm"
  const tomorrowMatch = lower.match(/^tomorrow\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (tomorrowMatch) {
    now.setDate(now.getDate() + 1);
    let hours = parseInt(tomorrowMatch[1]);
    const mins = tomorrowMatch[2] ? parseInt(tomorrowMatch[2]) : 0;
    const ampm = tomorrowMatch[3]?.toLowerCase();
    if (ampm === "pm" && hours < 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;
    now.setHours(hours, mins, 0, 0);
    return now.getTime();
  }

  return now.getTime();
}

// Tool summary for instructions
export function getToolSummary(): string {
  return `
Reminders:
  - scheduleReminder: Schedule a reminder with optional recurrence
  - listReminders: List all reminders
  - completeReminder: Mark a reminder as done
  - cancelReminder: Delete a reminder

Goals:
  - setGoal: Create a goal with optional milestones
  - listGoals: List goals by status
  - getGoalStatus: Get detailed goal info
  - completeMilestone: Complete a milestone
  - addMilestone: Add a milestone to a goal

Progress:
  - recordProgress: Record a metric value
  - getProgressHistory: View history
  - getProgressStats: Get statistics
  - listMetrics: List tracked metrics

Calendar:
  - createEvent: Create an event
  - listEvents: List events

Data:
  - collectData: Store data in a collection
  - queryData: Query data
  - listCollections: List collections`;
}
