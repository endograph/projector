import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { createBranch } from "./branching";
import {
  serializeNode,
  resolveNodeRef,
  deserializeInstance,
  buildSystemPrompt,
  getInstancePath,
  serializeNodeForDisplay,
  serializePackForDisplay,
} from "markov-machines";
import { isRef } from "markov-machines/client";
import { createDemoCharter } from "../../../apps/demo-agent/src/agent/charter.js";

// Charter for serialization ref resolution only — executor is unused
const charter = createDemoCharter({ executor: { run: async () => ({ response: [] }) } as any });

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

    // Extract clientIds from command messages for optimistic update reconciliation
    const recentCommandResidue: string[] = [];
    for (const msg of currentTurn.messages as any[]) {
      if (msg.role === "command" && Array.isArray(msg.items)) {
        for (const item of msg.items) {
          if (item.type === "command" && item.clientId) {
            recentCommandResidue.push(item.clientId);
          }
        }
      }
    }

    // Build speculative system prompt from deserialized instance
    let systemPrompt: string | undefined;
    try {
      const runtimeInstance = deserializeInstance(charter, currentTurn.instance);
      const path = getInstancePath(runtimeInstance);
      const ancestors = path.slice(0, -1);
      const activeInstance = path[path.length - 1];
      const packStates = runtimeInstance.packStates ?? {};
      // Use deserialized packs (with correct instructions) or fall back to node.packs
      const packs = runtimeInstance.packs ?? activeInstance.node.packs;

      systemPrompt = buildSystemPrompt(
        charter,
        activeInstance.node,
        activeInstance.state,
        ancestors,
        packStates,
        undefined,  // options
        packs,
      );
    } catch {
      // Silently skip if deserialization fails
      systemPrompt = undefined;
    }

    return {
      sessionId: id,
      turnId: session.currentTurnId,
      branchRootTurnId: session.branchRootTurnId,  // For time travel detection
      instanceId: currentTurn.instanceId,
      instance: currentTurn.instance,
      displayInstance: currentTurn.displayInstance,
      messages: currentTurn.messages,
      createdAt: currentTurn.createdAt,
      recentCommandResidue,
      systemPrompt,
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
      pack: v.optional(v.object({
        name: v.string(),
        instructions: v.optional(v.string()),
        state: v.optional(v.any()),
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

    // Handle pack edits (always applied to root instance)
    if (patch.pack) {
      const { name, instructions, state } = patch.pack;

      // Initialize packInstances if needed
      if (!modifiedInstance.packInstances) {
        modifiedInstance.packInstances = [];
      }

      // Find or create the pack instance entry
      let packInstance = modifiedInstance.packInstances.find(
        (pi: any) => (isRef(pi.pack) ? pi.pack.ref === name : pi.pack.name === name)
      );

      if (!packInstance) {
        // Create new pack instance as Ref
        packInstance = { state: state ?? {}, pack: { ref: name } };
        modifiedInstance.packInstances.push(packInstance);
      }

      // Update state if provided
      if (state !== undefined) {
        packInstance.state = state;
      }

      // Update instructions if provided - convert Ref to inline SerialPack
      if (instructions !== undefined) {
        if (isRef(packInstance.pack)) {
          // Convert Ref to inline SerialPack
          // Look up the charter pack to get description and other fields
          const charterPack = charter.packs?.find((p: any) => p.name === name);
          packInstance.pack = {
            name,
            description: charterPack?.description ?? "",
            instructions,
            validator: {}, // Will be filled by serialization at runtime
          };
        } else {
          // Already inline - just update instructions
          packInstance.pack.instructions = instructions;
        }
      }

      // Update display instance
      if (modifiedDisplayInstance) {
        // Update packStates
        if (!modifiedDisplayInstance.packStates) {
          modifiedDisplayInstance.packStates = {};
        }
        if (state !== undefined) {
          modifiedDisplayInstance.packStates[name] = state;
        }

        // Update the packs array in display nodes
        function updatePacksInDisplay(inst: any) {
          if (inst.node?.packs) {
            for (const pack of inst.node.packs) {
              if (pack.name === name) {
                if (state !== undefined) pack.state = state;
                if (instructions !== undefined) {
                  pack.instructions = instructions;
                  pack.instructionsDynamic = false;
                }
              }
            }
          }
          if (inst.packs) {
            for (const pack of inst.packs) {
              if (pack.name === name) {
                if (state !== undefined) pack.state = state;
                if (instructions !== undefined) {
                  pack.instructions = instructions;
                  pack.instructionsDynamic = false;
                }
              }
            }
          }
          if (inst.children) {
            for (const child of inst.children) {
              updatePacksInDisplay(child);
            }
          }
        }
        updatePacksInDisplay(modifiedDisplayInstance);
      }
    }

    // Handle instance-level edits (node state, node instructions, etc.)
    if (patch.state !== undefined || patch.node) {
      if (!patchSerializedNode(modifiedInstance)) {
        throw new Error(`Instance node ${instanceId} not found in instance tree`);
      }
      if (modifiedDisplayInstance) {
        patchDisplayNode(modifiedDisplayInstance);
      }
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

/**
 * Restore an inline node or pack back to charter defaults (ref format).
 * This reverts any user edits and stores the node/pack as a simple ref.
 */
export const restoreToCharter = mutation({
  args: {
    sessionId: v.id("sessions"),
    instanceId: v.string(),
    type: v.union(v.literal("node"), v.literal("pack")),
    name: v.string(), // For packs: pack name. For nodes: charter node name
  },
  handler: async (ctx, { sessionId, instanceId, type, name }) => {
    const session = await ctx.db.get(sessionId);
    if (!session?.currentTurnId) {
      throw new Error("Session has no current turn");
    }

    const currentTurn = await ctx.db.get(session.currentTurnId);
    if (!currentTurn) throw new Error("Current turn not found");

    const modifiedInstance = JSON.parse(JSON.stringify(currentTurn.instance));
    const modifiedDisplayInstance = currentTurn.displayInstance
      ? JSON.parse(JSON.stringify(currentTurn.displayInstance))
      : undefined;

    if (type === "node") {
      // Find and restore node to ref
      function restoreNode(inst: any): boolean {
        if (inst.id === instanceId) {
          inst.node = { ref: name };
          return true;
        }
        for (const child of inst.children || []) {
          if (restoreNode(child)) return true;
        }
        return false;
      }

      if (!restoreNode(modifiedInstance)) {
        throw new Error(`Instance ${instanceId} not found`);
      }

      // Update display instance - resolve node from charter
      if (modifiedDisplayInstance) {
        const charterNode = charter.nodes[name];
        if (!charterNode) {
          throw new Error(`Charter node ${name} not found`);
        }

        function updateDisplayNode(inst: any): boolean {
          if (inst.id === instanceId) {
            inst.node = serializeNodeForDisplay(charterNode, charter);
            return true;
          }
          for (const child of inst.children || []) {
            if (updateDisplayNode(child)) return true;
          }
          return false;
        }
        updateDisplayNode(modifiedDisplayInstance);
      }
    } else {
      // Restore pack to ref
      const packInstances = modifiedInstance.packInstances || [];
      const packInstance = packInstances.find(
        (pi: any) => (isRef(pi.pack) ? pi.pack.ref === name : pi.pack.name === name)
      );

      if (packInstance) {
        packInstance.pack = { ref: name };
      }

      // Update display instance - refresh pack display from charter defaults
      if (modifiedDisplayInstance) {
        // Find charter pack and refresh display packs
        const charterPack = charter.packs?.find((p: any) => p.name === name);
        if (charterPack && modifiedDisplayInstance.packs) {
          const packState = modifiedDisplayInstance.packStates?.[name] ?? charterPack.initialState ?? {};
          const updatedDisplayPack = serializePackForDisplay(charterPack, packState);

          // Update the pack in packs array
          const packIndex = modifiedDisplayInstance.packs.findIndex((p: any) => p.name === name);
          if (packIndex >= 0) {
            modifiedDisplayInstance.packs[packIndex] = updatedDisplayPack;
          }
        }
      }
    }

    // Create a new branch with the restored instance
    await createBranch(ctx, {
      sessionId,
      session,
      instanceId: currentTurn.instanceId,
      instance: modifiedInstance,
      displayInstance: modifiedDisplayInstance,
    });
  },
});
