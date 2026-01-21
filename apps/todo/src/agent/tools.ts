import { z } from "zod";
import type { ToolDefinition } from "markov-machines";
import { v4 as uuid } from "uuid";

export interface Todo {
  id: string;
  text: string;
  completed: boolean;
}

export interface TodoState {
  todos: Todo[];
}

export const listTodos: ToolDefinition<Record<string, never>, string, TodoState> = {
  name: "listTodos",
  description: "List all current todos",
  inputSchema: z.object({}),
  execute: (_input, ctx) => {
    const { todos } = ctx.state;
    if (todos.length === 0) {
      return "No todos yet. Add some!";
    }
    return todos
      .map((t, i) => `${i + 1}. [${t.completed ? "x" : " "}] ${t.text}`)
      .join("\n");
  },
};

export const addTodo: ToolDefinition<{ text: string }, string, TodoState> = {
  name: "addTodo",
  description: "Add a new todo item",
  inputSchema: z.object({
    text: z.string().describe("The todo item text"),
  }),
  execute: ({ text }, ctx) => {
    const newTodo: Todo = {
      id: uuid(),
      text,
      completed: false,
    };
    ctx.updateState({
      todos: [...ctx.state.todos, newTodo],
    });
    return `Added todo: "${text}"`;
  },
};

export const completeTodo: ToolDefinition<{ id: string }, string, TodoState> = {
  name: "completeTodo",
  description: "Mark a todo as completed",
  inputSchema: z.object({
    id: z.string().describe("The todo ID to complete"),
  }),
  execute: ({ id }, ctx) => {
    const todo = ctx.state.todos.find((t) => t.id === id);
    if (!todo) {
      return `Todo not found: ${id}`;
    }
    ctx.updateState({
      todos: ctx.state.todos.map((t) =>
        t.id === id ? { ...t, completed: true } : t
      ),
    });
    return `Completed: "${todo.text}"`;
  },
};

export const deleteTodo: ToolDefinition<{ id: string }, string, TodoState> = {
  name: "deleteTodo",
  description: "Delete a todo item",
  inputSchema: z.object({
    id: z.string().describe("The todo ID to delete"),
  }),
  execute: ({ id }, ctx) => {
    const todo = ctx.state.todos.find((t) => t.id === id);
    if (!todo) {
      return `Todo not found: ${id}`;
    }
    ctx.updateState({
      todos: ctx.state.todos.filter((t) => t.id !== id),
    });
    return `Deleted: "${todo.text}"`;
  },
};

// Archive state type
export interface ArchiveState {
  archivedTodos: Todo[];
}

export const listArchivedTodos: ToolDefinition<Record<string, never>, string, ArchiveState> = {
  name: "listArchivedTodos",
  description: "List all archived (completed) todos",
  inputSchema: z.object({}),
  execute: (_input, ctx) => {
    const { archivedTodos } = ctx.state;
    if (archivedTodos.length === 0) {
      return "No archived todos.";
    }
    return archivedTodos
      .map((t, i) => `${i + 1}. ${t.text}`)
      .join("\n");
  },
};

export const clearArchive: ToolDefinition<Record<string, never>, string, ArchiveState> = {
  name: "clearArchive",
  description: "Clear all archived todos",
  inputSchema: z.object({}),
  execute: (_input, ctx) => {
    ctx.updateState({ archivedTodos: [] });
    return "Archive cleared.";
  },
};

