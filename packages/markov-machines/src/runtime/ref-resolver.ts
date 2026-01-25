import type { Charter } from "../types/charter.js";
import type { Instance } from "../types/instance.js";
import type { AnyToolDefinition, AnthropicBuiltinTool } from "../types/tools.js";
import type { Transition } from "../types/transitions.js";
import type { AnyPackToolDefinition } from "../types/pack.js";
import type { Node, NodeToolEntry } from "../types/node.js";
import { isRef } from "../types/refs.js";

/**
 * Result of resolving a tool - includes the tool and its owner.
 */
export type ResolvedTool =
  | { tool: AnyToolDefinition | AnthropicBuiltinTool; owner: Instance | "charter" }
  | { tool: AnyPackToolDefinition; owner: { pack: string } };

/**
 * Resolve a tool by name, walking up from current instance to charter to packs.
 * Priority: node > ancestors > charter > packs (for packs referenced by current node).
 *
 * @param charter - The charter (final fallback before packs)
 * @param instance - Current node instance
 * @param ancestors - Parent instances from root to parent (not including current)
 * @param toolName - Name of the tool to resolve
 * @returns The tool definition and which instance owns it, or undefined if not found
 */
export function resolveTool(
  charter: Charter,
  instance: Instance,
  ancestors: Instance[],
  toolName: string,
): ResolvedTool | undefined {
  // First check current instance
  const currentTool = instance.node.tools[toolName];
  if (currentTool) {
    return { tool: currentTool, owner: instance };
  }

  // Walk up ancestors (from nearest parent to root)
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    if (!ancestor) continue;
    const ancestorTool = ancestor.node.tools[toolName];
    if (ancestorTool) {
      return { tool: ancestorTool, owner: ancestor };
    }
  }

  // Check charter tools
  const charterTool = charter.tools[toolName];
  if (charterTool) {
    return { tool: charterTool, owner: "charter" };
  }

  // Finally check pack tools (for packs on current node, only for non-worker nodes)
  // Worker nodes don't have access to packs
  if (!instance.node.worker) {
    for (const pack of instance.node.packs ?? []) {
      const packTool = pack.tools[toolName];
      if (packTool) {
        return { tool: packTool, owner: { pack: pack.name } };
      }
    }
  }

  return undefined;
}

/**
 * Resolve a transition by name from the current node.
 * Transitions are scoped to own node only (no ancestor lookup).
 *
 * @param instance - Current node instance
 * @param transitionName - Name of the transition
 * @returns The transition or undefined if not found
 */
export function resolveTransition(
  instance: Instance,
  transitionName: string,
): Transition<unknown> | undefined {
  return instance.node.transitions[transitionName];
}

/**
 * Resolve a transition reference to the actual transition object.
 * If the transition is already a concrete transition, returns it as-is.
 * If it's a Ref, looks up the transition in the charter's transitions registry.
 *
 * @param charter - The charter containing the transitions registry
 * @param transition - The transition or ref to resolve
 * @returns The resolved transition
 * @throws Error if the ref points to an unknown transition
 */
export function resolveTransitionRef<S>(
  charter: Charter,
  transition: Transition<S>,
): Transition<S> {
  if (isRef(transition)) {
    const resolved = charter.transitions[transition.ref];
    if (!resolved) {
      throw new Error(`Unknown transition ref: ${transition.ref}`);
    }
    return resolved as Transition<S>;
  }
  return transition;
}

