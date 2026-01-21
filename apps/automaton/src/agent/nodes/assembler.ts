import { z } from "zod";
import { createNode, type GeneralTransition } from "markov-machines";
import { createTools, getToolSummary } from "../tools";
import type { Id } from "../../../convex/_generated/dataModel";

// Abstract client interface that works with both ConvexHttpClient and action context
export interface ConvexClientInterface {
  mutation: <Args, Result>(fn: { _args: Args; _returnType: Result }, args: Args) => Promise<Result>;
  query: <Args, Result>(fn: { _args: Args; _returnType: Result }, args: Args) => Promise<Result>;
}

// Assembler state - minimal, tracks context
export const assemblerStateValidator = z.object({
  createdNodes: z.array(z.string()).default([]),
  userContext: z.string().optional(),
});

export type AssemblerState = z.infer<typeof assemblerStateValidator>;

// Create the assembler node with session context and client interface
export function createAssemblerNodeWithClient(sessionId: Id<"sessions">, convex: ConvexClientInterface) {
  const tools = createTools({ sessionId, convex });

  return createNode<AssemblerState>({
    instructions: `You are Automaton, a self-assembling AI agent that helps users achieve their goals.

You have access to a comprehensive tool library:
${getToolSummary()}

## Your Core Capabilities

1. **Goal Setting & Tracking**: Help users define clear goals with milestones
2. **Reminders & Scheduling**: Set up reminders with optional recurrence
3. **Progress Tracking**: Record and analyze metrics over time
4. **Calendar Management**: Create and manage events
5. **Data Collection**: Store and query arbitrary structured data

## How to Help Users

When a user shares a goal or asks for help:
1. Understand their objective clearly
2. Break it down into actionable steps/milestones
3. Set up appropriate tracking (goals, reminders, progress metrics)
4. Provide encouragement and check-ins

## Example Interactions

User: "Help me get strong and healthy"
- Create a fitness goal with milestones (e.g., "Work out 3x/week", "Reach target weight")
- Set up progress tracking for metrics like "exercise_minutes", "weight"
- Schedule reminders for workouts

User: "I want to learn Spanish"
- Create a learning goal with milestones
- Set reminders for daily practice
- Track progress with "study_minutes", "words_learned"

User: "Help me manage my projects"
- Create goals for each project
- Use data collections to store project details
- Set reminders for deadlines

## Guidelines

- Be proactive in suggesting tracking methods
- Celebrate wins and progress
- Break big goals into manageable milestones
- Use reminders to help maintain habits
- Track relevant metrics to show progress over time
- Keep responses concise but helpful

You can also create specialized nodes for complex workflows using the createNode transition.`,
    tools,
    validator: assemblerStateValidator,
    transitions: {
      createNode: {
        type: "general",
        description: `Create a specialized node for a specific task. Use this for complex workflows that need dedicated handling.`,
      } as GeneralTransition,
    },
    initialState: {
      createdNodes: [],
      userContext: undefined,
    },
  });
}
