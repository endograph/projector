import { v4 as uuid } from "uuid";
import type { Node } from "./node.js";
import type { StandardNodeConfig } from "../executor/types.js";
import type { SuspendResult } from "./transitions.js";

/**
 * Helper to extract state type from a Node type.
 * Constrained to Node to avoid unbounded type inference.
 */
export type NodeState<N extends Node> = N extends Node<infer S> ? S : unknown;

/**
 * Information about a suspended instance.
 */
export interface SuspendInfo {
  /** Unique ID for this suspension - must match to resume */
  suspendId: string;
  /** Human-readable reason for suspension */
  reason: string;
  /** When the instance was suspended */
  suspendedAt: Date;
  /** Optional metadata for application use */
  metadata?: Record<string, unknown>;
}

/**
 * Runtime node instance with state and optional children.
 * Forms a tree structure where nodes can spawn children.
 * @typeParam N - The node type (full Node<S> type for type inference).
 */
export interface Instance<N extends Node = Node> {
  /** Unique identifier for this instance */
  id: string;
  /** The node definition */
  node: N;
  /** Current state for this node */
  state: NodeState<N>;
  /** Optional child instances - always an array when present */
  children?: Instance[];
  /** Pack states (only on root instance, shared across all nodes) */
  packStates?: Record<string, unknown>;
  /** Effective executor config for this instance (override or from node) */
  executorConfig?: StandardNodeConfig;
  /** Suspension info - if present, instance is suspended */
  suspended?: SuspendInfo;
}

/**
 * Create a new instance with auto-generated ID.
 * Accepts either a single child or array for convenience - normalizes to array internally.
 */
export function createInstance<N extends Node>(
  node: N,
  state: NodeState<N>,
  children?: Instance | Instance[],
  packStates?: Record<string, unknown>,
  executorConfig?: StandardNodeConfig,
): Instance<N> {
  // Normalize children to array
  let normalizedChildren: Instance[] | undefined;
  if (children !== undefined) {
    normalizedChildren = Array.isArray(children) ? children : [children];
  }

  return {
    id: uuid(),
    node,
    state,
    children: normalizedChildren,
    packStates,
    executorConfig,
  };
}

/**
 * Check if a value is an Instance.
 */
export function isInstance<N extends Node = Node>(value: unknown): value is Instance<N> {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "node" in value &&
    "state" in value
  );
}

/**
 * Check if an instance is a worker instance.
 */
export function isWorkerInstance(instance: Instance): boolean {
  return instance.node.worker === true;
}

/**
 * Get children of an instance as an array.
 * Returns empty array if no children.
 */
export function getChildren(inst: Instance): Instance[] {
  return inst.children ?? [];
}

/**
 * Get the primary active instance by following the last child at each level.
 * Used for operations that need a single target (e.g., command routing when no instanceId specified).
 * Note: For parallel execution, use getActiveLeaves() which returns ALL non-suspended leaves.
 */
export function getActiveInstance(instance: Instance): Instance {
  let current: Instance = instance;
  while (current.children && current.children.length > 0) {
    const lastChild = current.children[current.children.length - 1];
    if (!lastChild) break;
    current = lastChild;
  }
  return current;
}

/**
 * Get path from root to the primary active leaf (following last child at each level).
 * Used for single-path tree operations. For parallel execution, use getActiveLeaves().
 */
export function getInstancePath(instance: Instance): Instance[] {
  const path: Instance[] = [];
  let current: Instance | undefined = instance;
  while (current) {
    path.push(current);
    const children: Instance[] | undefined = current.children;
    if (!children || children.length === 0) break;
    current = children[children.length - 1];
  }
  return path;
}

/**
 * Get ALL instances in the tree (depth-first).
 * Traverses all children in arrays.
 * Includes cycle detection and max depth protection.
 *
 * @param instance - The root instance to start traversal from
 * @param maxDepth - Maximum depth to traverse (default 100, protects against cycles)
 * @returns Array of all instances in the tree
 * @throws Error if a cycle is detected or max depth is exceeded
 */
export function getAllInstances(instance: Instance, maxDepth = 100): Instance[] {
  const visited = new Set<string>();

  function traverse(inst: Instance, depth: number): Instance[] {
    if (depth > maxDepth) {
      throw new Error(
        `Max depth (${maxDepth}) exceeded in instance tree traversal. Possible cycle detected.`,
      );
    }

    if (visited.has(inst.id)) {
      throw new Error(
        `Cycle detected in instance tree: instance "${inst.id}" was already visited.`,
      );
    }
    visited.add(inst.id);

    const result: Instance[] = [inst];
    for (const child of getChildren(inst)) {
      result.push(...traverse(child, depth + 1));
    }
    return result;
  }

  return traverse(instance, 0);
}

/**
 * Information about an active leaf instance for parallel execution.
 */
export interface ActiveLeafInfo {
  /** Path from root to leaf (inclusive) */
  path: Instance[];
  /** Index path for tree updates (e.g., [0, 2] = root.children[0].children[2]) */
  leafIndex: number[];
  /** Whether this is a worker instance */
  isWorker: boolean;
}

/**
 * Get all active leaf instances in the tree.
 * For parallel execution, finds all leaves that should execute.
 * Suspended instances are excluded.
 *
 * @param instance - The root instance
 * @returns Array of ActiveLeafInfo for each leaf
 */
export function getActiveLeaves(instance: Instance): ActiveLeafInfo[] {
  const results: ActiveLeafInfo[] = [];

  function traverse(inst: Instance, path: Instance[], indices: number[]): void {
    const currentPath = [...path, inst];

    // Skip suspended instances
    if (inst.suspended) {
      return;
    }

    const children = getChildren(inst);
    if (children.length === 0) {
      // Leaf node - include it
      results.push({
        path: currentPath,
        leafIndex: indices,
        isWorker: isWorkerInstance(inst),
      });
      return;
    }

    children.forEach((child, i) => traverse(child, currentPath, [...indices, i]));
  }

  traverse(instance, [], []);
  return results;
}

/**
 * Check if an instance is suspended.
 */
export function isSuspendedInstance(instance: Instance): boolean {
  return instance.suspended !== undefined;
}

/**
 * Get all suspended instances in the tree.
 */
export function getSuspendedInstances(instance: Instance, maxDepth = 100): Instance[] {
  const all = getAllInstances(instance, maxDepth);
  return all.filter(inst => inst.suspended !== undefined);
}

/**
 * Find an instance by ID in the tree.
 * Uses early return for efficiency - stops as soon as the ID is found.
 */
export function findInstanceById(root: Instance, id: string, maxDepth = 100): Instance | undefined {
  const visited = new Set<string>();

  function search(inst: Instance, depth: number): Instance | undefined {
    if (depth > maxDepth) return undefined;
    if (visited.has(inst.id)) return undefined;
    visited.add(inst.id);

    // Early return if found
    if (inst.id === id) return inst;

    for (const child of getChildren(inst)) {
      const found = search(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  return search(root, 0);
}

/**
 * Create SuspendInfo from a SuspendResult.
 */
export function createSuspendInfo(result: SuspendResult): SuspendInfo {
  return {
    suspendId: result.suspendId,
    reason: result.reason,
    suspendedAt: new Date(),
    metadata: result.metadata,
  };
}

/**
 * Clear suspension from an instance.
 * Returns a new instance without the suspended field.
 */
export function clearSuspension(instance: Instance): Instance {
  const { suspended: _, ...rest } = instance;
  return rest as Instance;
}
