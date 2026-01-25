import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createCharter } from "../core/charter.js";
import { createNode } from "../core/node.js";
import { createInstance } from "../types/instance.js";
import { createMachine } from "../core/machine.js";
import { getAvailableCommands, runCommand } from "../core/commands.js";
import { commandValue } from "../types/commands.js";
import type { Executor, RunResult, RunOptions } from "../executor/types.js";
import type { Charter } from "../types/charter.js";
import type { Instance } from "../types/instance.js";

/**
 * Mock executor for testing - commands don't use the executor,
 * but we need one to create a valid charter.
 */
function createMockExecutor(): Executor {
  return {
    type: "standard",
    run: async (
      _charter: Charter,
      instance: Instance,
      _ancestors: Instance[],
      _input: string,
      _options?: RunOptions,
    ): Promise<RunResult> => {
      return {
        instance,
        messages: [],
        yieldReason: "end_turn",
      };
    },
  };
}

// Simple state schema for testing
const todoStateValidator = z.object({
  todos: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      completed: z.boolean(),
    }),
  ),
});
type TodoState = z.infer<typeof todoStateValidator>;

describe("getAvailableCommands", () => {
  it("should return empty array when no commands defined", () => {
    const node = createNode<TodoState>({
      instructions: "Test node",
      validator: todoStateValidator,
      initialState: { todos: [] },
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { node },
    });

    const machine = createMachine(charter, {
      instance: createInstance(node, { todos: [] }),
    });

    const commands = getAvailableCommands(machine);
    expect(commands).toEqual([]);
  });

  it("should return available commands", () => {
    const node = createNode<TodoState>({
      instructions: "Test node",
      validator: todoStateValidator,
      initialState: { todos: [] },
      commands: {
        clearAll: {
          name: "clearAll",
          description: "Clear all todos",
          inputSchema: z.object({}),
          execute: (_, ctx) => {
            ctx.updateState({ todos: [] });
            return commandValue(null);
          },
        },
        addTodo: {
          name: "addTodo",
          description: "Add a new todo",
          inputSchema: z.object({ text: z.string() }),
          execute: (input, ctx) => {
            const newTodo = { id: "1", text: input.text, completed: false };
            ctx.updateState({ todos: [...ctx.state.todos, newTodo] });
            return commandValue(newTodo);
          },
        },
      },
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { node },
    });

    const machine = createMachine(charter, {
      instance: createInstance(node, { todos: [] }),
    });

    const commands = getAvailableCommands(machine);
    expect(commands).toHaveLength(2);
    expect(commands.map((c) => c.name).sort()).toEqual(["addTodo", "clearAll"]);
    expect(commands.find((c) => c.name === "clearAll")?.description).toBe("Clear all todos");
  });
});

describe("runCommand", () => {
  it("should return error for unknown command", async () => {
    const node = createNode<TodoState>({
      instructions: "Test node",
      validator: todoStateValidator,
      initialState: { todos: [] },
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { node },
    });

    const machine = createMachine(charter, {
      instance: createInstance(node, { todos: [] }),
    });

    const { result } = await runCommand(machine, "unknownCommand", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Command not found");
  });

  it("should return error for invalid input", async () => {
    const node = createNode<TodoState>({
      instructions: "Test node",
      validator: todoStateValidator,
      initialState: { todos: [] },
      commands: {
        addTodo: {
          name: "addTodo",
          description: "Add a new todo",
          inputSchema: z.object({ text: z.string() }),
          execute: (input, ctx) => {
            const newTodo = { id: "1", text: input.text, completed: false };
            ctx.updateState({ todos: [...ctx.state.todos, newTodo] });
            return commandValue(newTodo);
          },
        },
      },
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { node },
    });

    const machine = createMachine(charter, {
      instance: createInstance(node, { todos: [] }),
    });

    // Missing required 'text' field
    const { result } = await runCommand(machine, "addTodo", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid input");
  });

  it("should execute command and update state", async () => {
    const node = createNode<TodoState>({
      instructions: "Test node",
      validator: todoStateValidator,
      initialState: { todos: [] },
      commands: {
        addTodo: {
          name: "addTodo",
          description: "Add a new todo",
          inputSchema: z.object({ text: z.string() }),
          execute: (input, ctx) => {
            const newTodo = { id: "1", text: input.text, completed: false };
            ctx.updateState({ todos: [...ctx.state.todos, newTodo] });
            return commandValue(newTodo);
          },
        },
      },
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { node },
    });

    const machine = createMachine(charter, {
      instance: createInstance(node, { todos: [] }),
    });

    const { machine: updated, result } = await runCommand(machine, "addTodo", { text: "Buy milk" });

    expect(result.success).toBe(true);
    expect(result.value).toEqual({ id: "1", text: "Buy milk", completed: false });
    expect(updated.instance.state).toEqual({
      todos: [{ id: "1", text: "Buy milk", completed: false }],
    });
  });

  it("should execute command that clears state", async () => {
    const node = createNode<TodoState>({
      instructions: "Test node",
      validator: todoStateValidator,
      initialState: { todos: [] },
      commands: {
        clearAll: {
          name: "clearAll",
          description: "Clear all todos",
          inputSchema: z.object({}),
          execute: (_, ctx) => {
            ctx.updateState({ todos: [] });
            return commandValue({ cleared: ctx.state.todos.length });
          },
        },
      },
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { node },
    });

    const initialTodos = [
      { id: "1", text: "Buy milk", completed: false },
      { id: "2", text: "Walk dog", completed: true },
    ];

    const machine = createMachine(charter, {
      instance: createInstance(node, { todos: initialTodos }),
    });

    const { machine: updated, result } = await runCommand(machine, "clearAll", {});

    expect(result.success).toBe(true);
    expect(result.value).toEqual({ cleared: 2 });
    expect(updated.instance.state).toEqual({ todos: [] });
  });

  it("should handle async commands", async () => {
    const node = createNode<TodoState>({
      instructions: "Test node",
      validator: todoStateValidator,
      initialState: { todos: [] },
      commands: {
        asyncAdd: {
          name: "asyncAdd",
          description: "Add a todo asynchronously",
          inputSchema: z.object({ text: z.string() }),
          execute: async (input, ctx) => {
            // Simulate async operation
            await new Promise((resolve) => setTimeout(resolve, 10));
            const newTodo = { id: "async-1", text: input.text, completed: false };
            ctx.updateState({ todos: [...ctx.state.todos, newTodo] });
            return commandValue(newTodo);
          },
        },
      },
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { node },
    });

    const machine = createMachine(charter, {
      instance: createInstance(node, { todos: [] }),
    });

    const { machine: updated, result } = await runCommand(machine, "asyncAdd", { text: "Async task" });

    expect(result.success).toBe(true);
    expect(result.value).toEqual({ id: "async-1", text: "Async task", completed: false });
    expect(updated.instance.state).toEqual({
      todos: [{ id: "async-1", text: "Async task", completed: false }],
    });
  });

  it("should handle command errors gracefully", async () => {
    const node = createNode<TodoState>({
      instructions: "Test node",
      validator: todoStateValidator,
      initialState: { todos: [] },
      commands: {
        throwError: {
          name: "throwError",
          description: "A command that throws",
          inputSchema: z.object({}),
          execute: () => {
            throw new Error("Something went wrong!");
          },
        },
      },
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { node },
    });

    const machine = createMachine(charter, {
      instance: createInstance(node, { todos: [] }),
    });

    const { result } = await runCommand(machine, "throwError", {});

    expect(result.success).toBe(false);
    expect(result.error).toBe("Something went wrong!");
  });
});

describe("command with spawn", () => {
  it("should spawn child instance from command", async () => {
    const childStateValidator = z.object({ query: z.string() });
    type ChildState = z.infer<typeof childStateValidator>;

    const childNode = createNode<ChildState>({
      instructions: "Child node",
      validator: childStateValidator,
      initialState: { query: "" },
    });

    const parentNode = createNode<TodoState>({
      instructions: "Parent node",
      validator: todoStateValidator,
      initialState: { todos: [] },
      commands: {
        spawnResearcher: {
          name: "spawnResearcher",
          description: "Spawn a researcher child",
          inputSchema: z.object({ query: z.string() }),
          execute: (input, ctx) => {
            return ctx.spawn(childNode, { query: input.query }) as any;
          },
        },
      },
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { parentNode, childNode },
    });

    const machine = createMachine(charter, {
      instance: createInstance(parentNode, { todos: [] }),
    });

    const { machine: updated, result } = await runCommand(machine, "spawnResearcher", {
      query: "test query",
    });

    expect(result.success).toBe(true);
    expect(updated.instance.children).toBeDefined();
    expect(updated.instance.children?.length).toBe(1);
    const child = updated.instance.children![0]!;
    expect(child.node.id).toBe(childNode.id);
    expect(child.state).toEqual({ query: "test query" });
  });
});

describe("command with cede", () => {
  it("should cede from child to parent", async () => {
    const childStateValidator = z.object({ result: z.string() });
    type ChildState = z.infer<typeof childStateValidator>;

    const childNode = createNode<ChildState>({
      instructions: "Child node",
      validator: childStateValidator,
      initialState: { result: "" },
      commands: {
        complete: {
          name: "complete",
          description: "Complete and cede to parent",
          inputSchema: z.object({}),
          execute: (_, ctx) => {
            return ctx.cede({ findings: ctx.state.result } as any);
          },
        },
      },
    });

    const parentNode = createNode<TodoState>({
      instructions: "Parent node",
      validator: todoStateValidator,
      initialState: { todos: [] },
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { parentNode, childNode },
    });

    // Start with parent that has a child
    const childInstance = createInstance(childNode, { result: "found stuff" });
    const parentInstance = createInstance(parentNode, { todos: [] }, childInstance);

    const machine = createMachine(charter, {
      instance: parentInstance,
    });

    const { machine: updated, result } = await runCommand(machine, "complete", {});

    expect(result.success).toBe(true);
    expect(result.value).toEqual({ findings: "found stuff" });
    // Child should be removed after cede
    expect(updated.instance.children).toBeUndefined();
  });

  it("should error when trying to cede from root", async () => {
    const node = createNode<TodoState>({
      instructions: "Root node",
      validator: todoStateValidator,
      initialState: { todos: [] },
      commands: {
        tryToCede: {
          name: "tryToCede",
          description: "Try to cede from root",
          inputSchema: z.object({}),
          execute: (_, ctx) => {
            return ctx.cede({ data: "test" } as any);
          },
        },
      },
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { node },
    });

    const machine = createMachine(charter, {
      instance: createInstance(node, { todos: [] }),
    });

    const { result } = await runCommand(machine, "tryToCede", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("Cannot cede from root");
  });
});

describe("createNode command validation", () => {
  it("should throw when command name does not match key", () => {
    expect(() => {
      createNode<TodoState>({
        instructions: "Test node",
        validator: todoStateValidator,
        initialState: { todos: [] },
        commands: {
          wrongKey: {
            name: "correctName",
            description: "Mismatched names",
            inputSchema: z.object({}),
            execute: () => commandValue(null),
          },
        },
      });
    }).toThrow("Node command name mismatch");
  });
});
