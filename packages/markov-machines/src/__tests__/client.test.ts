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
import { isCommand, commandResult } from "../types/commands.js";
import { createPack } from "../core/pack.js";

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
            return commandResult(null);
          },
        },
        addTodo: {
          name: "addTodo",
          description: "Add a new todo",
          inputSchema: z.object({ text: z.string() }),
          execute: (input, ctx) => {
            const newTodo = { id: "1", text: input.text, completed: false };
            ctx.updateState({ todos: [...ctx.state.todos, newTodo] });
            return commandResult(newTodo);
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

  it("should include packs with state, validator, and commands when node has packs", () => {
    const testPack = createPack({
      name: "testPack",
      description: "Test pack with commands",
      validator: z.object({ counter: z.number() }),
      initialState: { counter: 0 },
      commands: {
        incrementCounter: {
          name: "incrementCounter",
          description: "Increment the counter",
          inputSchema: z.object({ amount: z.number().optional() }),
          execute: (input, ctx) => {
            ctx.updateState({ counter: ctx.state.counter + (input.amount ?? 1) });
          },
        },
        resetCounter: {
          name: "resetCounter",
          description: "Reset the counter to zero",
          inputSchema: z.object({}),
          execute: (_, ctx) => {
            ctx.updateState({ counter: 0 });
          },
        },
      },
    });

    const node = createNode<TodoState>({
      instructions: "Test node with pack",
      validator: todoStateValidator,
      initialState: { todos: [] },
      packs: [testPack],
    });

    const instance = createInstance(
      node,
      { todos: [] },
      undefined,
      { testPack: { counter: 42 } },
    );

    const dryInstance = createDryClientInstance(instance);

    // Should have packs array
    expect(dryInstance.packs).toBeDefined();
    expect(dryInstance.packs).toHaveLength(1);

    const pack = dryInstance.packs![0]!;
    expect(pack.name).toBe("testPack");
    expect(pack.description).toBe("Test pack with commands");
    expect(pack.state).toEqual({ counter: 42 });
    expect(pack.validator).toBeDefined();

    // Pack commands
    expect(Object.keys(pack.commands)).toHaveLength(2);
    expect(pack.commands.incrementCounter).toBeDefined();
    expect(pack.commands.incrementCounter!.name).toBe("incrementCounter");
    expect(pack.commands.incrementCounter!.description).toBe("Increment the counter");
    expect(pack.commands.resetCounter).toBeDefined();
    expect(pack.commands.resetCounter!.name).toBe("resetCounter");
  });

  it("should use initialState when packStates not provided", () => {
    const testPack = createPack({
      name: "testPack",
      description: "Test pack",
      validator: z.object({ counter: z.number() }),
      initialState: { counter: 100 },
    });

    const node = createNode<TodoState>({
      instructions: "Test node",
      validator: todoStateValidator,
      initialState: { todos: [] },
      packs: [testPack],
    });

    const instance = createInstance(node, { todos: [] });
    const dryInstance = createDryClientInstance(instance);

    expect(dryInstance.packs).toHaveLength(1);
    expect(dryInstance.packs![0]!.state).toEqual({ counter: 100 });
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
            return commandResult(newTodo);
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
            return commandResult(null);
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

  it("should hydrate packs with callable command functions", () => {
    const testPack = createPack({
      name: "testPack",
      description: "Test pack with commands",
      validator: z.object({ counter: z.number() }),
      initialState: { counter: 0 },
      commands: {
        incrementCounter: {
          name: "incrementCounter",
          description: "Increment the counter",
          inputSchema: z.object({ amount: z.number().optional() }),
          execute: (input, ctx) => {
            ctx.updateState({ counter: ctx.state.counter + (input.amount ?? 1) });
          },
        },
      },
    });

    const node = createNode<TodoState>({
      instructions: "Test node",
      validator: todoStateValidator,
      initialState: { todos: [] },
      packs: [testPack],
    });

    const instance = createInstance(
      node,
      { todos: [] },
      undefined,
      { testPack: { counter: 42 } },
    );

    const dryInstance = createDryClientInstance(instance);
    const clientInstance = hydrateClientInstance(dryInstance);

    // Check packs are hydrated
    expect(clientInstance.packs).toBeDefined();
    expect(clientInstance.packs).toHaveLength(1);

    const pack = clientInstance.packs![0]!;
    expect(pack.name).toBe("testPack");
    expect(pack.state).toEqual({ counter: 42 });
    expect(pack.validator).toBeDefined();

    // Pack command should be callable
    expect(typeof pack.commands.incrementCounter).toBe("function");
    const command = pack.commands.incrementCounter!({ amount: 5 });
    expect(isCommand(command)).toBe(true);
    expect(command.name).toBe("incrementCounter");
    expect(command.input).toEqual({ amount: 5 });
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
