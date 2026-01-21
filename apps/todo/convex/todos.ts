import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("todos").collect();
  },
});

export const sync = mutation({
  args: {
    todos: v.array(
      v.object({
        id: v.string(),
        text: v.string(),
        completed: v.boolean(),
      })
    ),
  },
  handler: async (ctx, { todos }) => {
    // Clear existing todos and replace with new ones
    const existing = await ctx.db.query("todos").collect();
    for (const todo of existing) {
      await ctx.db.delete(todo._id);
    }

    // Insert new todos
    for (const todo of todos) {
      await ctx.db.insert("todos", {
        text: todo.text,
        completed: todo.completed,
        createdAt: Date.now(),
      });
    }
  },
});
