"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { z } from "zod";
import {
  runCommand,
  createMachine,
  serializeInstance,
  deserializeInstance,
  getAvailableCommands,
  type Message,
} from "markov-machines";
import { demoCharter } from "../src/agent/charter";
import { serializeInstanceForDisplay } from "../src/serializeForDisplay";

// Escape $ prefixed fields from JSON schema (Convex doesn't allow $ fields)
// $schema -> __$schema, $ref -> __$ref, etc.
function escapeDollarFields(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(escapeDollarFields);
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const escapedKey = key.startsWith("$") ? `__${key}` : key;
      result[escapedKey] = escapeDollarFields(value);
    }
    return result;
  }
  return obj;
}

// Filter out messages with empty content (Anthropic API requires non-empty content)
function filterValidMessages(messages: Message[]): Message[] {
  return messages.filter((msg) => {
    if (!msg.content) return false;
    if (Array.isArray(msg.content)) {
      return msg.content.length > 0;
    }
    if (typeof msg.content === "string") {
      return msg.content.length > 0;
    }
    return true;
  });
}

export const executeCommand = action({
  args: {
    sessionId: v.id("sessions"),
    commandName: v.string(),
    input: v.any(),
    instanceId: v.optional(v.string()),
  },
  handler: async (ctx, { sessionId, commandName, input, instanceId }): Promise<{ success: boolean; value?: unknown; error?: string }> => {
    const session = await ctx.runQuery(api.sessions.get, { id: sessionId });
    if (!session) {
      throw new Error("Session not found");
    }

    const history = await ctx.runQuery(api.sessions.getFullHistory, { sessionId });

    const instance = deserializeInstance(demoCharter, session.instance);

    const machine = createMachine(demoCharter, {
      instance,
      history: filterValidMessages(history as Message[]),
    });

    const { machine: updatedMachine, result, replyMessages } = await runCommand(
      machine,
      commandName,
      input,
      instanceId
    );

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Command execution failed",
      };
    }

    const serializedInstance = serializeInstance(updatedMachine.instance, demoCharter);
    const displayInstance = serializeInstanceForDisplay(updatedMachine.instance, demoCharter);

    const turnId = await ctx.runMutation(api.machineTurns.create, {
      sessionId,
      parentId: session.turnId,
      instanceId: updatedMachine.instance.id,
      instance: serializedInstance,
      displayInstance,
    });

    await ctx.runMutation(api.machineSteps.add, {
      sessionId,
      turnId,
      stepNumber: 1,
      yieldReason: "command",
      response: JSON.stringify(result),
      done: true,
      messages: [],
      instance: serializedInstance,
      displayInstance,
      activeNodeInstructions: updatedMachine.instance.node.instructions?.slice(0, 100) || "",
    });

    await ctx.runMutation(api.sessions.finalizeTurn, {
      turnId,
      instance: serializedInstance,
      displayInstance,
      messages: [],
    });

    if (replyMessages?.userMessage) {
      await ctx.runMutation(api.messages.add, {
        sessionId,
        role: "assistant",
        content: String(replyMessages.userMessage),
        turnId,
      });
    }

    return {
      success: true,
      value: result,
    };
  },
});

export const getCommands = action({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.runQuery(api.sessions.get, { id: sessionId });
    if (!session) {
      return [];
    }

    const instance = deserializeInstance(demoCharter, session.instance);

    const machine = createMachine(demoCharter, {
      instance,
      history: [],
    });

    const commands = getAvailableCommands(machine);

    // Convert Zod schemas to JSON-serializable format (escape $ fields for Convex)
    return commands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      inputSchema: escapeDollarFields(z.toJSONSchema(cmd.inputSchema)),
    }));
  },
});
