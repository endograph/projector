import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { createBranch } from "./branching";
import { serializeNode, resolveNodeRef } from "markov-machines";
import { isRef } from "markov-machines/client";
import { createDemoCharter } from "../../../apps/demo-agent/src/agent/charter.js";

// Charter for serialization ref resolution only — executor is unused
const charter = createDemoCharter({ run: async () => ({ response: [] }) } as any);

export const create = mutation({
  args: {
    instanceId: v.string(),
    instance: v.any(),
    displayInstance: v.optional(v.any()),
  },
  handler: async (ctx, { instanceId, instance, displayInstance }) => {
    const sessionId = await ctx.db.insert("sessions", {
      currentTurnId: undefined,
      branchRootTurnId: undefined,
    });

    const turnId = await ctx.db.insert("machineTurns", {
      sessionId,
      parentId: undefined,
      instanceId,
      instance,
      displayInstance,
      messages: [],
      createdAt: Date.now(),
    });

    await ctx.db.patch(sessionId, {
      currentTurnId: turnId,
      branchRootTurnId: turnId,
      branchAncestors: [turnId],
    });

    return sessionId;
  },
});

export const get = query({
  args: { id: v.id("sessions") },
  handler: async (ctx, { id }) => {
    const session = await ctx.db.get(id);
    if (!session || !session.currentTurnId) return null;

    const currentTurn = await ctx.db.get(session.currentTurnId);
    if (!currentTurn) return null;

    return {
      sessionId: id,
      turnId: session.currentTurnId,
      branchRootTurnId: session.branchRootTurnId,  // For time travel detection
      instanceId: currentTurn.instanceId,
      instance: currentTurn.instance,
      displayInstance: currentTurn.displayInstance,
      messages: currentTurn.messages,
      createdAt: currentTurn.createdAt,
    };
  },
});

export const getFullHistory = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session?.currentTurnId) return [];

    const allTurns = await ctx.db
      .query("machineTurns")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();

    const turnMap = new Map(allTurns.map((t) => [t._id, t]));

    const orderedTurns: typeof allTurns = [];
    let currentId: Id<"machineTurns"> | undefined = session.currentTurnId;

    while (currentId) {
      const turn = turnMap.get(currentId);
      if (!turn) break;
      orderedTurns.unshift(turn);
      currentId = turn.parentId ?? undefined;
    }

    const messages: unknown[] = [];
    for (const turn of orderedTurns) {
      messages.push(...turn.messages);
    }

    return messages;
  },
});

export const finalizeTurn = mutation({
  args: {
    turnId: v.id("machineTurns"),
    instance: v.any(),
    displayInstance: v.optional(v.any()),
    messages: v.array(v.any()),
  },
  handler: async (ctx, { turnId, instance, displayInstance, messages }) => {
    await ctx.db.patch(turnId, { instance, displayInstance, messages });
  },
});

export const getTurnTree = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return null;

    const turns = await ctx.db
      .query("machineTurns")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();

    return {
      currentTurnId: session.currentTurnId,
      turns,
    };
  },
});

export const timeTravel = mutation({
  args: {
    sessionId: v.id("sessions"),
    targetTurnId: v.id("machineTurns"),
  },
  handler: async (ctx, { sessionId, targetTurnId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("Session not found");

    const targetTurn = await ctx.db.get(targetTurnId);
    if (!targetTurn) throw new Error("Target turn not found");

    if (targetTurn.sessionId !== sessionId) {
      throw new Error("Target turn belongs to a different session");
    }

    await ctx.db.patch(sessionId, {
      currentTurnId: targetTurnId,
      branchRootTurnId: undefined,  // signals time-travel mode; branch created on next turn
    });
  },
});

export const updateInstance = mutation({
  args: {
    sessionId: v.id("sessions"),
    instance: v.any(),
    displayInstance: v.optional(v.any()),
  },
  handler: async (ctx, { sessionId, instance, displayInstance }) => {
    const session = await ctx.db.get(sessionId);
    if (!session?.currentTurnId) {
      throw new Error("Session has no current turn");
    }

    await ctx.db.patch(session.currentTurnId, { instance, displayInstance });
  },
});

/**
 * Edit the current instance and create a new branch.
 * Patches a specific node in the instance tree (identified by instanceId)
 * with the provided fields, then branches from the current turn.
 *
 * Patch shape mirrors the instance: { state?, node?: { instructions?, validator? } }
 * When patching a Ref node, it's converted to an inline SerialNode using serializeNode.
 */
export const editCurrentInstance = mutation({
  args: {
    sessionId: v.id("sessions"),
    instanceId: v.string(),
    patch: v.object({
      state: v.optional(v.any()),
      node: v.optional(v.object({
        instructions: v.optional(v.string()),
        validator: v.optional(v.any()),
      })),
    }),
  },
  handler: async (ctx, { sessionId, instanceId, patch }) => {
    const session = await ctx.db.get(sessionId);
    if (!session?.currentTurnId) {
      throw new Error("Session has no current turn");
    }

    const currentTurn = await ctx.db.get(session.currentTurnId);
    if (!currentTurn) throw new Error("Current turn not found");

    // Deep clone instance and displayInstance
    const modifiedInstance = JSON.parse(JSON.stringify(currentTurn.instance));
    const modifiedDisplayInstance = currentTurn.displayInstance
      ? JSON.parse(JSON.stringify(currentTurn.displayInstance))
      : undefined;

    // Walk serialized instance tree and apply patch
    function patchSerializedNode(inst: any): boolean {
      if (inst.id === instanceId) {
        // Patch state (instance-level)
        if (patch.state !== undefined) {
          inst.state = patch.state;
        }

        // Patch node fields
        if (patch.node) {
          if (isRef(inst.node)) {
            // Resolve Ref → runtime Node, apply edits, re-serialize as inline
            const runtimeNode = resolveNodeRef(charter, inst.node);
            const edited = {
              ...runtimeNode,
              ...(patch.node.instructions !== undefined ? { instructions: patch.node.instructions } : {}),
              ...(patch.node.validator !== undefined ? { validator: patch.node.validator } : {}),
            };
            inst.node = serializeNode(edited, charter, { noNodeRef: true });
          } else {
            // Already inline SerialNode — patch fields directly
            if (patch.node.instructions !== undefined) {
              inst.node.instructions = patch.node.instructions;
            }
            if (patch.node.validator !== undefined) {
              inst.node.validator = patch.node.validator;
            }
          }
        }
        return true;
      }
      if (inst.children) {
        for (const child of inst.children) {
          if (patchSerializedNode(child)) return true;
        }
      }
      return false;
    }

    // Walk display instance tree and apply patch (display nodes are always resolved)
    function patchDisplayNode(inst: any): boolean {
      if (inst.id === instanceId) {
        if (patch.state !== undefined) {
          inst.state = patch.state;
        }
        if (patch.node) {
          if (patch.node.instructions !== undefined) {
            inst.node.instructions = patch.node.instructions;
          }
          if (patch.node.validator !== undefined) {
            inst.node.validator = patch.node.validator;
          }
        }
        return true;
      }
      if (inst.children) {
        for (const child of inst.children) {
          if (patchDisplayNode(child)) return true;
        }
      }
      return false;
    }

    if (!patchSerializedNode(modifiedInstance)) {
      throw new Error(`Instance node ${instanceId} not found in instance tree`);
    }
    if (modifiedDisplayInstance) {
      patchDisplayNode(modifiedDisplayInstance);
    }

    // Create a new branch with the modified instance
    await createBranch(ctx, {
      sessionId,
      session,
      instanceId: currentTurn.instanceId,
      instance: modifiedInstance,
      displayInstance: modifiedDisplayInstance,
    });
  },
});
