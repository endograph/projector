"use node";

import { v } from "convex/values";
import { action, ActionCtx } from "./_generated/server";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  runMachine,
  createMachine,
  serializeInstance,
  deserializeInstance,
  createInstance,
  type Instance,
  type Node,
  type Message,
  type MachineStep,
} from "markov-machines";
import {
  automatonCharter,
  createSessionAssemblerNodeWithClient,
  createInitialState,
} from "../src/agent/charter";

// Create a wrapper around action context that matches the ConvexClientInterface
function createContextClient(ctx: ActionCtx) {
  return {
    mutation: <Args, Result>(fn: { _args: Args; _returnType: Result }, args: Args): Promise<Result> => {
      return ctx.runMutation(fn as any, args as any);
    },
    query: <Args, Result>(fn: { _args: Args; _returnType: Result }, args: Args): Promise<Result> => {
      return ctx.runQuery(fn as any, args as any);
    },
  };
}

// Helper to extract truncated node instructions from instance
function getActiveNodeInstructions(instance: Instance): string {
  const instructions = instance.node.instructions || "";
  return instructions.slice(0, 100);
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

    // Ensure assembler node is created with session context
    const convexClient = createContextClient(ctx);
    createSessionAssemblerNodeWithClient(sessionId, convexClient);

    // Deserialize the instance from persisted state
    const instance = deserializeInstance(automatonCharter, session.instance);

    // Create machine with history
    const machine = createMachine(automatonCharter, {
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
    const turnId = await ctx.runMutation(api.machineTurns.create, {
      sessionId,
      parentId: session.turnId,
      instanceId: machine.instance.id,
      instance: serializeInstance(machine.instance, automatonCharter),
    });

    let stepNumber = 0;
    let lastStep: MachineStep | null = null;
    const allMessages: Message[] = [];

    // Iterate through each step and store it
    for await (const step of runMachine(machine, message, { maxSteps: 15 })) {
      stepNumber++;
      allMessages.push(...step.messages);

      // Store each step with full instance snapshot
      await ctx.runMutation(api.machineSteps.add, {
        sessionId,
        turnId,
        stepNumber,
        yieldReason: step.yieldReason,
        response: step.response,
        done: step.done,
        messages: step.messages,
        instance: serializeInstance(step.instance, automatonCharter),
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
      instance: serializeInstance(lastStep.instance, automatonCharter),
      messages: allMessages,
    });

    // Add assistant message to UI (linked to turn for debugging)
    await ctx.runMutation(api.messages.add, {
      sessionId,
      role: "assistant",
      content: lastStep.response,
      turnId,
    });

    return lastStep.response;
  },
});

export const createSession = action({
  args: {},
  handler: async (ctx): Promise<Id<"sessions">> => {
    const initialState = createInitialState();

    // Create context client for tools
    const convexClient = createContextClient(ctx);

    // Create a temporary session ID to pass to node creation
    // We'll create the actual session first, then update
    const tempSessionId = await ctx.runMutation(api.sessions.create, {
      instanceId: "temp",
      instance: {},
    });

    // Create assembler node with session context
    const assemblerNode = createSessionAssemblerNodeWithClient(tempSessionId, convexClient);

    // Create instance
    const instance: Instance = createInstance(
      assemblerNode as Node<unknown>,
      initialState,
    );

    // Serialize for storage
    const serializedInstance = serializeInstance(instance, automatonCharter);

    // Update the session with the real instance
    await ctx.runMutation(api.sessions.finalizeTurn, {
      turnId: (await ctx.runQuery(api.sessions.get, { id: tempSessionId }))!.turnId,
      instance: serializedInstance,
      messages: [],
    });

    return tempSessionId;
  },
});
