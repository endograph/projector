import { z } from "zod";
import {
	createCharter,
	createNode,
	createStandardExecutor,
	createTransition,
	transitionTo,
	spawn,
	type Node,
	type TransitionResult,
} from "markov-machines";
import {
	listTodos,
	addTodo,
	completeTodo,
	deleteTodo,
	listArchivedTodos,
	clearArchive,
	type TodoState,
	type ArchiveState,
} from "./tools";
import { guidancePack } from "./packs/guidance";
import { productResearcherNode } from "./nodes/productResearcher";


const appMessageSchema = z.object({
	title: z.string(),
	description: z.string(),
	metadata: z.record(z.string(), z.any()),
})
type AppMessage = {
	title: string,
	description: string,
	metadata: Record<string, any>,
}

// State validators
export const todoStateValidator = z.object({
	todos: z.array(
		z.object({
			id: z.string(),
			text: z.string(),
			completed: z.boolean(),
		})
	),
});

export const archiveStateValidator = z.object({
	archivedTodos: z.array(
		z.object({
			id: z.string(),
			text: z.string(),
			completed: z.boolean(),
		})
	),
});

// Create archive node first
// Explicit type annotation to break circular reference with mainNode
const archiveNode = createNode({
	instructions: `You are viewing the archive of completed todos.

	Available actions:
	- Use listArchivedTodos to see all archived (completed) todos
- Use clearArchive to delete all archived todos

You can transition back to the main todo list when done.

Be concise and helpful.`,
	tools: {
		listArchivedTodos,
		clearArchive,
	},
	validator: archiveStateValidator,
	transitions: {
		backToMain: createTransition<ArchiveState>({
			description: "Return to the main todo list",
			execute: (): TransitionResult => transitionTo(mainNode, undefined),
		}),
	},
	initialState: { archivedTodos: [] },
});

// Create main node
// Explicit type annotation to break circular reference with archiveNode
// Uses Node<never, any> to opt out of state contravariance checking
const mainNode = createNode({
	instructions: `You are a helpful todo assistant. Help users manage their todos.

	Available actions:
	- Use listTodos to see current todos
- Use addTodo to create new todos
- Use completeTodo to mark a todo as done (use the todo's ID)
- Use deleteTodo to remove a todo (use the todo's ID)

You can also:
- Transition to the archive to view completed todos
- Spawn a product researcher to help research products for todo items
- Use setGuidance to store user preferences (e.g., "products: prefer natural materials, BIFL quality")

When listing todos, always show the ID so users can reference them.
Always confirm actions with the user after completing them.
Be concise and helpful.`,
	tools: {
		listTodos,
		addTodo,
		completeTodo,
		deleteTodo,
	},
	validator: todoStateValidator,
	transitions: {
		toArchive: createTransition<TodoState>({
			description: "View the archive of completed todos",
			execute: (state): TransitionResult =>
				transitionTo(archiveNode, {
					archivedTodos: state.todos.filter((t) => t.completed),
				}),
		}),
		spawnResearcher: createTransition<TodoState>({
			description:
				"Spawn a product researcher to investigate a product. Use when user needs help researching something to buy. Pass any relevant guidance from the guidance pack.",
			arguments: z.object({
				query: z.string().describe("What to research (e.g., 'best wool blankets', 'durable hiking boots')"),
				guidance: z
					.string()
					.optional()
					.describe("Relevant user preferences (materials, budget, etc.), if any"),
			}),
			execute: (_state, ctx): TransitionResult => {
				const args = ctx.args as { query: string; guidance?: string };
				return spawn(productResearcherNode, {
					query: args.query,
					findings: [],
					guidance: args.guidance,
				});
			},
		}),
	},
	packs: [guidancePack],
	initialState: { todos: [] },
});

// Create charter with single executor
export const todoCharter = createCharter<AppMessage>({
	name: "todo-assistant",
	executor: createStandardExecutor({
		apiKey: process.env.ANTHROPIC_API_KEY,
		model: "claude-sonnet-4-5",
		maxTokens: 1024 * 10,
		debug: false,
	}),
	packs: [guidancePack],
	nodes: {
		mainNode,
		archiveNode,
		productResearcherNode,
	},
});

// Re-export for external use
export { mainNode, archiveNode };

// Initial state factory
export function createInitialState(): TodoState {
	return {
		todos: [],
	};
}
