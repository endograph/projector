# Automaton: Self-Assembling Agent

A general-purpose agent that defines its own nodes and transitions dynamically based on user goals.

## Core Concept

The agent starts with a single **Assembler Node** that understands user goals and uses `GeneralTransition` to create specialized nodes on-the-fly. Unlike pre-defined node structures, the agent decides what nodes it needs based on the user's request.

**Example Flow:**
1. User: "Help me get strong and healthy"
2. Assembler analyzes goal, plans node structure
3. Creates nodes: DailyCheckin, ExerciseTracker, SupplementTracker, ProgressReview
4. Transitions into the created structure

## Architecture

### Charter Structure

```
automatonCharter
├── executor: StandardExecutor (Claude Sonnet)
├── nodes:
│   └── assemblerNode (root node that creates others)
├── tools: (library available to all nodes)
│   ├── Reminders: scheduleReminder, listReminders, completeReminder, cancelReminder
│   ├── Progress: recordProgress, getProgressHistory, setMilestone, completeMilestone
│   ├── Goals: setGoal, updateGoal, getGoalStatus, listGoals
│   ├── Data: collectData, queryData, aggregateData, exportData
│   ├── Calendar: createEvent, listEvents, updateEvent, deleteEvent
│   ├── Notifications: sendNotification, setNotificationPreferences
│   └── Web: web_search (Anthropic builtin)
├── transitions:
│   └── toAssembler (return to root)
└── packs:
    ├── preferencesPack (user settings)
    └── memoryPack (long-term context)
```

### Dynamic Node Creation

The Assembler uses `GeneralTransition` to create inline nodes:
- **Instructions**: Natural language describing the node's role
- **Validator**: JSON Schema (serializable) converted to Zod at runtime
- **Tools**: References to charter-level tools (can't have inline execute functions)
- **Transitions**: References to charter-registered transitions

### Database Schema (Convex)

**Core tables** (from todo pattern):
- `sessions` - current turn pointer
- `machineTurns` - instance snapshots per turn
- `machineSteps` - debugging granularity
- `messages` - chat history

**Automaton-specific tables**:
- `reminders` - scheduled actions with recurrence
- `progressEntries` - tracked metrics over time
- `goals` - user objectives with status/deadlines
- `dataCollections` - flexible JSON data storage
- `calendarEvents` - scheduled events
- `nodeDefinitions` - persisted dynamic node references

### Frontend

```
┌─────────────────────────────────────────────────────┐
│  Automaton                                          │
├──────────────┬──────────────────────────────────────┤
│ Node Tree    │  Chat Panel                          │
│              │                                      │
│ ▼ Assembler  │  User: Help me get strong...         │
│   ├ Checkin  │                                      │
│   └ Tracker  │  Assistant: I'll create a system... │
│              │                                      │
│ ────────────│                                      │
│ Goals (3)    │  [Input field]              [Send]  │
│ Reminders(2) │                                      │
└──────────────┴──────────────────────────────────────┘
```

## Implementation Steps

### Phase 1: Foundation
1. **Set up Convex** in apps/automaton
   - `bunx convex dev` to initialize
   - Create `convex/schema.ts` with core tables
   - Add ConvexProvider to layout

2. **Add dependencies** to package.json
   - `markov-machines` (workspace: `"markov-machines": "workspace:*"`)
   - `convex`, `jotai`, `js-cookie`, `zod`

3. **Create charter** with assembler node
   - `src/agent/charter.ts`
   - `src/agent/nodes/assembler.ts`

4. **Session management**
   - `convex/sessions.ts` - create, get, finalizeTurn
   - `convex/chat.ts` - send action (run machine)
   - `src/atoms.ts` - sessionIdAtom, sidebarOpenAtom, devModeAtom
   - `src/hooks.ts` - useSessionId

### Phase 2: Chat UI
5. **Chat components**
   - `app/HomeClient.tsx` - main layout with sidebar + chat
   - `app/components/ChatPanel.tsx` - messages list + input
   - `app/components/ChatMessage.tsx` - individual message
   - `app/components/ChatInput.tsx` - input with send
   - `app/components/ThinkingIndicator.tsx`

6. **Node tree sidebar**
   - `app/components/NodeTree/NodeTree.tsx` - tree visualization
   - `app/components/NodeTree/NodeTreeItem.tsx` - recursive item

### Phase 3: Tool Library
7. **Add automaton tables** to schema
   - reminders, progressEntries, goals, dataCollections, calendarEvents

8. **Implement tools** (start with core set)
   - `src/agent/tools/reminders.ts`
   - `src/agent/tools/progress.ts`
   - `src/agent/tools/goals.ts`
   - Each tool calls Convex mutations

9. **Convex mutations** for each tool
   - `convex/reminders.ts`
   - `convex/progress.ts`
   - `convex/goals.ts`

### Phase 4: Dynamic Node Creation
10. **Enhance assembler node**
    - Add GeneralTransition for `createNode`
    - Comprehensive instructions explaining tool library
    - Test inline node creation

11. **Pre-registered transitions**
    - `toAssembler` - return to root
    - `cedeToParent` - for spawned nodes

### Phase 5: Extended Features
12. **Complete tool library**
    - Calendar tools + `convex/calendar.ts`
    - Data collection tools + `convex/data.ts`
    - Notification tools
    - `web_search` (Anthropic builtin)

13. **Packs**
    - `src/agent/packs/preferences.ts`
    - `src/agent/packs/memory.ts`

14. **Polish**
    - Dev mode toggle (Option+D)
    - Message debug modal
    - Error handling

## Key Files to Create

```
apps/automaton/
├── app/
│   ├── layout.tsx (update with providers)
│   ├── page.tsx (server component)
│   ├── HomeClient.tsx
│   └── components/
│       ├── ChatPanel.tsx
│       ├── ChatMessage.tsx
│       ├── ChatInput.tsx
│       ├── ThinkingIndicator.tsx
│       └── NodeTree/
│           ├── NodeTree.tsx
│           └── NodeTreeItem.tsx
├── src/
│   ├── atoms.ts
│   ├── hooks.ts
│   └── agent/
│       ├── charter.ts
│       ├── nodes/
│       │   └── assembler.ts
│       ├── tools/
│       │   ├── reminders.ts
│       │   ├── progress.ts
│       │   ├── goals.ts
│       │   ├── calendar.ts
│       │   └── data.ts
│       └── packs/
│           ├── preferences.ts
│           └── memory.ts
└── convex/
    ├── _generated/ (auto)
    ├── schema.ts
    ├── sessions.ts
    ├── chat.ts
    ├── messages.ts
    ├── reminders.ts
    ├── progress.ts
    ├── goals.ts
    ├── calendar.ts
    └── data.ts
```

## Key Design Decisions

1. **Tools are charter-level**: Inline nodes can't have executable tool functions (not serializable). All tools registered in charter, nodes reference by name.

2. **State schemas as JSON Schema**: Dynamic nodes define validators as JSON Schema (serializable), converted to Zod at runtime.

3. **Single root node pattern**: One assembler node creates all others dynamically, maximizing flexibility.

4. **Tool context includes Convex client**: Tools receive sessionId + convexClient for persistence.

## Reference Files

- `packages/markov-machines/src/types/transitions.ts` - GeneralTransition type
- `apps/todo/convex/chat.ts` - Convex action pattern
- `apps/todo/src/agent/charter.ts` - Charter definition pattern
- `apps/todo/app/HomeClient.tsx` - React chat component pattern
