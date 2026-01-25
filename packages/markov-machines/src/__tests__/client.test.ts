import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createNode } from "../core/node.js";
import { createInstance } from "../types/instance.js";
import {
  createDryClientNode,
  createDryClientInstance,
  hydrateClientNode,
  hydrateClientInstance,
} from "../core/client.js";
import { isCommand, commandValue } from "../types/commands.js";

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

describe("createDryClientNode", () => {
  it("should create a dry client node with instructions and validator", () => {
    const node = createNode<TodoState>({
      instructions: "Test node instructions",
      validator: todoStateValidator,
      initialState: { todos: [] },
    });

    const dryNode = createDryClientNode(node);

    expect(dryNode.instructions).toBe("Test node instructions");
    expect(dryNode.validator).toBeDefined();
    expect(dryNode.commands).toEqual({});
  });

  it("should include command metadata in dry client node", () => {
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

    const dryNode = createDryClientNode(node);

    expect(Object.keys(dryNode.commands)).toHaveLength(2);
    expect(dryNode.commands.clearAll).toBeDefined();
    expect(dryNode.commands.clearAll?.name).toBe("clearAll");
    expect(dryNode.commands.clearAll?.description).toBe("Clear all todos");
    expect(dryNode.commands.clearAll?.inputSchema).toBeDefined();

    expect(dryNode.commands.addTodo).toBeDefined();
    expect(dryNode.commands.addTodo?.name).toBe("addTodo");
    expect(dryNode.commands.addTodo?.description).toBe("Add a new todo");
  });
});

describe("createDryClientInstance", () => {
  it("should create a dry client instance with id, state, and node", () => {
    const node = createNode<TodoState>({
      instructions: "Test node",
      validator: todoStateValidator,
      initialState: { todos: [] },
    });

    const instance = createInstance(node, {
      todos: [{ id: "1", text: "Test todo", completed: false }],
    });

    const dryInstance = createDryClientInstance(instance);

    expect(dryInstance.id).toBe(instance.id);
    expect(dryInstance.state).toEqual({
      todos: [{ id: "1", text: "Test todo", completed: false }],
    });
    expect(dryInstance.node.instructions).toBe("Test node");
  });

  it("should include packStates when present", () => {
    const node = createNode<TodoState>({
      instructions: "Test node",
      validator: todoStateValidator,
      initialState: { todos: [] },
    });

    const instance = createInstance(
      node,
      { todos: [] },
      undefined,
      { myPack: { counter: 5 } },
    );

    const dryInstance = createDryClientInstance(instance);

    expect(dryInstance.packStates).toEqual({ myPack: { counter: 5 } });
  });
});

describe("hydrateClientNode", () => {
  it("should create callable command functions", () => {
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

    const dryNode = createDryClientNode(node);
    const clientNode = hydrateClientNode(dryNode);

    expect(clientNode.instructions).toBe("Test node");
    expect(clientNode.commands.addTodo).toBeDefined();
    expect(typeof clientNode.commands.addTodo).toBe("function");

    // Call the command function
    const command = (clientNode.commands as any).addTodo({ text: "Buy milk" });

    expect(isCommand(command)).toBe(true);
    expect(command.type).toBe("command");
    expect(command.name).toBe("addTodo");
    expect(command.input).toEqual({ text: "Buy milk" });
  });
});

describe("hydrateClientInstance", () => {
  it("should hydrate a dry instance with callable commands", () => {
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
      },
    });

    const instance = createInstance(node, {
      todos: [{ id: "1", text: "Test", completed: false }],
    });

    const dryInstance = createDryClientInstance(instance);
    const clientInstance = hydrateClientInstance(dryInstance);

    // Check instance properties
    expect(clientInstance.id).toBe(instance.id);
    expect(clientInstance.state).toEqual({
      todos: [{ id: "1", text: "Test", completed: false }],
    });

    // Check hydrated commands
    const command = (clientInstance.node.commands as any).clearAll({});
    expect(isCommand(command)).toBe(true);
    expect(command.name).toBe("clearAll");
  });

  it("should preserve packStates through hydration", () => {
    const node = createNode<TodoState>({
      instructions: "Test node",
      validator: todoStateValidator,
      initialState: { todos: [] },
    });

    const instance = createInstance(
      node,
      { todos: [] },
      undefined,
      { myPack: { data: "test" } },
    );

    const dryInstance = createDryClientInstance(instance);
    const clientInstance = hydrateClientInstance(dryInstance);

    expect(clientInstance.packStates).toEqual({ myPack: { data: "test" } });
  });
});

describe("isCommand", () => {
  it("should return true for valid Command objects", () => {
    const command = { type: "command", name: "test", input: {} };
    expect(isCommand(command)).toBe(true);
  });

  it("should return false for invalid objects", () => {
    expect(isCommand(null)).toBe(false);
    expect(isCommand(undefined)).toBe(false);
    expect(isCommand({})).toBe(false);
    expect(isCommand({ type: "other" })).toBe(false);
    expect(isCommand({ type: "command" })).toBe(false); // missing name
    expect(isCommand({ name: "test" })).toBe(false); // missing type
  });
});
