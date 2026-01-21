"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  runMachine,
  createMachine,
  serializeInstance,
  deserializeInstance,
  createInstance,
  getMessageText,
  type Instance,
  type Node,
  type Message,
  type MachineStep,
} from "markov-machines";
import { todoCharter, mainNode, createInitialState } from "../src/agent/charter";

// Helper to extract truncated node instructions from instance
function getActiveNodeInstructions(instance: Instance): string {
  const instructions = instance.node.instructions || "";
  return instructions.slice(0, 100);
}

// Helper to extract response text from step messages
function getStepResponse(step: MachineStep<unknown>): string {
  // Find the last assistant message and extract its text
  for (let i = step.messages.length - 1; i >= 0; i--) {
    const msg = step.messages[i];
    if (msg && msg.role === "assistant") {
      return getMessageText(msg);
    }
  }
  return "";
}

export const send = action({
  args: {
    sessionId: v.id("sessions"),
    message: v.string(),
  },
  handler: async (ctx, { sessionId, message }): Promise<string> => {
    // Get session with current instance
    const session = await ctx.runQuery(api.sessions.get, { id: sessionId });
    if (!session) {
      throw new Error("Session not found");
    }

    // Get full history by walking the turn chain
    const history = await ctx.runQuery(api.sessions.getFullHistory, { sessionId });

    // Deserialize the instance from persisted state
    const instance = deserializeInstance(todoCharter, session.instance);

    // Create machine with history
    const machine = createMachine(todoCharter, {
      instance,
      history: history as Message[],
    });

    // Add user message to UI
    await ctx.runMutation(api.messages.add, {
      sessionId,
      role: "user",
      content: message,
    });

    // Create turn entry first (to get turnId for steps)
    // This also updates session.currentTurnId
    const turnId = await ctx.runMutation(api.machineTurns.create, {
      sessionId,
      parentId: session.turnId,
      instanceId: machine.instance.id,
      instance: serializeInstance(machine.instance, todoCharter),
    });

    let stepNumber = 0;
    let lastStep: MachineStep | null = null;
    const allMessages: Message[] = [];

    // Iterate through each step and store it
    for await (const step of runMachine(machine, message, { maxSteps: 10 })) {
      stepNumber++;
      allMessages.push(...step.messages);

      // Store each step with full instance snapshot
      await ctx.runMutation(api.machineSteps.add, {
        sessionId,
        turnId,
        stepNumber,
        yieldReason: step.yieldReason,
        response: getStepResponse(step),
        done: step.done,
        messages: step.messages,
        instance: serializeInstance(step.instance, todoCharter),
        activeNodeInstructions: getActiveNodeInstructions(step.instance),
      });

      lastStep = step;
    }

    if (!lastStep) {
      throw new Error("No steps executed");
    }

    // Finalize turn with final instance and accumulated messages
    await ctx.runMutation(api.sessions.finalizeTurn, {
      turnId,
      instance: serializeInstance(lastStep.instance, todoCharter),
      messages: allMessages,
    });

    // Sync todos to Convex (if state has todos)
    const currentState = lastStep.instance.state;
    if (currentState && typeof currentState === "object" && "todos" in currentState) {
      const todos = (currentState as { todos: Array<{ id: string; text: string; completed: boolean }> }).todos;
      await ctx.runMutation(api.todos.sync, { todos });
    }

    // Add assistant message to UI (linked to turn for debugging)
    const responseText = getStepResponse(lastStep);
    await ctx.runMutation(api.messages.add, {
      sessionId,
      role: "assistant",
      content: responseText,
      turnId,
    });

    return responseText;
  },
});

export const createSession = action({
  args: {},
  handler: async (ctx): Promise<Id<"sessions">> => {
    const initialState = createInitialState();

    // Create instance
    const instance: Instance = createInstance(
      mainNode as Node<unknown>,
      initialState,
    );

    // Serialize for storage
    const serializedInstance = serializeInstance(instance, todoCharter);

    const sessionId = await ctx.runMutation(api.sessions.create, {
      instanceId: instance.id,
      instance: serializedInstance,
    });

    return sessionId;
  },
});
