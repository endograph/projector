import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createCharter } from "../core/charter.js";
import { createNode, createWorkerNode } from "../core/node.js";
import {
  createInstance,
  getActiveLeaves,
  isWorkerInstance,
} from "../types/instance.js";
import { createMachine } from "../core/machine.js";
import { runMachine, runMachineToCompletion } from "../core/run.js";
import type {
  Executor,
  RunResult,
  RunOptions,
  MachineStep,
} from "../executor/types.js";
import type { Charter } from "../types/charter.js";
import type { Instance } from "../types/instance.js";

/**
 * Helper to collect all steps from the async generator.
 */
async function collectSteps(
  generator: AsyncGenerator<MachineStep>,
): Promise<MachineStep[]> {
  const steps: MachineStep[] = [];
  for await (const step of generator) {
    steps.push(step);
  }
  return steps;
}

/**
 * Mock executor that tracks calls and allows custom behavior per instance.
 */
function createTrackingMockExecutor(
  behavior: (
    charter: Charter<unknown>,
    instance: Instance,
    ancestors: Instance[],
    input: string,
    callIndex: number,
  ) => Partial<RunResult<unknown>>,
): { executor: Executor<unknown>; getCalls: () => Array<{ instance: Instance; input: string }> } {
  const calls: Array<{ instance: Instance; input: string }> = [];
  let callIndex = 0;

  const executor: Executor<unknown> = {
    type: "standard",
    run: async (
      charter: Charter<unknown>,
      instance: Instance,
      ancestors: Instance[],
      input: string,
      _options?: RunOptions<unknown>,
    ): Promise<RunResult<unknown>> => {
      calls.push({ instance, input });
      const result = behavior(charter, instance, ancestors, input, callIndex++);
      return {
        instance: result.instance ?? instance,
        messages: result.messages ?? [],
        yieldReason: result.yieldReason ?? "end_turn",
        cedeContent: result.cedeContent,
        packStates: result.packStates,
      };
    },
  };

  return { executor, getCalls: () => calls };
}

// Simple state schemas for testing
const standardStateValidator = z.object({
  value: z.string(),
});
type StandardState = z.infer<typeof standardStateValidator>;

const workerStateValidator = z.object({
  task: z.string(),
  result: z.string().optional(),
});
type WorkerState = z.infer<typeof workerStateValidator>;

describe("worker node types", () => {
  it("should correctly identify worker nodes", () => {
    // Create a standard node
    const standardNode = createNode<StandardState>({
      instructions: "Standard node",
      validator: standardStateValidator,
      initialState: { value: "standard" },
    });

    // Create a worker node
    const workerNode = createWorkerNode<WorkerState>({
      instructions: "Worker node",
      validator: workerStateValidator,
      initialState: { task: "background", result: undefined },
    });

    expect(standardNode.worker).not.toBe(true);
    expect(workerNode.worker).toBe(true);
  });

  it("should correctly identify worker instances", () => {
    const standardNode = createNode<StandardState>({
      instructions: "Standard node",
      validator: standardStateValidator,
      initialState: { value: "standard" },
    });

    const workerNode = createWorkerNode<WorkerState>({
      instructions: "Worker node",
      validator: workerStateValidator,
      initialState: { task: "background", result: undefined },
    });

    const standardInstance = createInstance(standardNode, { value: "test" });
    const workerInstance = createInstance(workerNode, { task: "bg", result: undefined });

    expect(isWorkerInstance(standardInstance)).toBe(false);
    expect(isWorkerInstance(workerInstance)).toBe(true);
  });
});

describe("getActiveLeaves", () => {
  it("should return single leaf for simple tree", () => {
    const node = createNode<StandardState>({
      instructions: "Node",
      validator: standardStateValidator,
      initialState: { value: "test" },
    });

    const instance = createInstance(node, { value: "test" });
    const leaves = getActiveLeaves(instance);

    expect(leaves.length).toBe(1);
    expect(leaves[0]?.leafIndex).toEqual([]);
    expect(leaves[0]?.isWorker).toBe(false);
  });

  it("should return single leaf for parent-child tree", () => {
    const parentNode = createNode<StandardState>({
      instructions: "Parent",
      validator: standardStateValidator,
      initialState: { value: "parent" },
    });

    const childNode = createNode<StandardState>({
      instructions: "Child",
      validator: standardStateValidator,
      initialState: { value: "child" },
    });

    const child = createInstance(childNode, { value: "child" });
    const parent = createInstance(parentNode, { value: "parent" }, child);

    const leaves = getActiveLeaves(parent);

    expect(leaves.length).toBe(1);
    expect(leaves[0]?.leafIndex).toEqual([0]);
    expect(leaves[0]?.path.length).toBe(2);
    expect(leaves[0]?.path[0]).toBe(parent);
    expect(leaves[0]?.path[1]).toBe(child);
  });

  it("should return multiple leaves for tree with multiple children", () => {
    const parentNode = createNode<StandardState>({
      instructions: "Parent",
      validator: standardStateValidator,
      initialState: { value: "parent" },
    });

    const childNode = createNode<StandardState>({
      instructions: "Child",
      validator: standardStateValidator,
      initialState: { value: "child" },
    });

    const workerChildNode = createWorkerNode<WorkerState>({
      instructions: "Worker child",
      validator: workerStateValidator,
      initialState: { task: "bg", result: undefined },
    });

    const child1 = createInstance(workerChildNode, { task: "bg1", result: undefined });
    const child2 = createInstance(childNode, { value: "main" });

    const parent = createInstance(parentNode, { value: "parent" }, [child1, child2]);

    const leaves = getActiveLeaves(parent);

    expect(leaves.length).toBe(2);

    // First leaf (worker)
    expect(leaves[0]?.leafIndex).toEqual([0]);
    expect(leaves[0]?.isWorker).toBe(true);

    // Second leaf (non-worker)
    expect(leaves[1]?.leafIndex).toEqual([1]);
    expect(leaves[1]?.isWorker).toBe(false);
  });

  it("should return correct indices for deeply nested tree", () => {
    const node = createNode<StandardState>({
      instructions: "Node",
      validator: standardStateValidator,
      initialState: { value: "test" },
    });

    // Build tree: root -> [child0, child1 -> grandchild]
    const grandchild = createInstance(node, { value: "grandchild" });
    const child0 = createInstance(node, { value: "child0" });
    const child1 = createInstance(node, { value: "child1" }, grandchild);
    const root = createInstance(node, { value: "root" }, [child0, child1]);

    const leaves = getActiveLeaves(root);

    expect(leaves.length).toBe(2);
    expect(leaves[0]?.leafIndex).toEqual([0]); // child0 is a leaf
    expect(leaves[1]?.leafIndex).toEqual([1, 0]); // child1 -> grandchild
  });
});

describe("parallel execution validation", () => {
  it("should throw error when multiple non-worker leaves exist", async () => {
    const nodeA = createNode<StandardState>({
      instructions: "Node A",
      validator: standardStateValidator,
      initialState: { value: "a" },
    });

    const nodeB = createNode<StandardState>({
      instructions: "Node B",
      validator: standardStateValidator,
      initialState: { value: "b" },
    });

    const { executor } = createTrackingMockExecutor(() => ({
      yieldReason: "end_turn",
    }));

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { nodeA, nodeB },
    });

    // Create tree with two non-worker children
    const childA = createInstance(nodeA, { value: "a" });
    const childB = createInstance(nodeB, { value: "b" });
    const root = createInstance(nodeA, { value: "root" }, [childA, childB]);

    const machine = createMachine(charter, { instance: root });

    await expect(runMachineToCompletion(machine, "test")).rejects.toThrow(
      /Invalid state: 2 non-worker active leaves/
    );
  });

  it("should allow one non-worker and one worker leaf", async () => {
    const standardNode = createNode<StandardState>({
      instructions: "Standard",
      validator: standardStateValidator,
      initialState: { value: "main" },
    });

    const workerNode = createWorkerNode<WorkerState>({
      instructions: "Worker",
      validator: workerStateValidator,
      initialState: { task: "bg", result: undefined },
    });

    let callCount = 0;
    const { executor, getCalls } = createTrackingMockExecutor(
      (_charter, instance, _ancestors, _input) => {
        callCount++;
        // Worker node cedes, standard node ends turn
        if (instance.node.worker) {
          return {
            yieldReason: "cede",
            cedePayload: { done: true },
          };
        }
        return {
          yieldReason: "end_turn",
          messages: [{ role: "assistant" as const, content: "Done!" }],
        };
      }
    );

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { standardNode, workerNode },
    });

    // One worker, one standard child
    const workerChild = createInstance(workerNode, { task: "bg", result: undefined });
    const standardChild = createInstance(standardNode, { value: "main" });
    const root = createInstance(standardNode, { value: "root" }, [workerChild, standardChild]);

    const machine = createMachine(charter, { instance: root });
    const result = await runMachineToCompletion(machine, "test");

    // Both should have been called in parallel
    expect(callCount).toBe(2);

    // Verify worker node received empty input
    const calls = getCalls();
    const workerCall = calls.find((c) => c.instance.node.worker);
    expect(workerCall?.input).toBe("");

    const nonWorkerCall = calls.find((c) => !c.instance.node.worker);
    expect(nonWorkerCall?.input).toBe("test");
  });
});

describe("worker node must cede", () => {
  it("should warn when worker node returns end_turn without ceding", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const standardNode = createNode<StandardState>({
      instructions: "Standard",
      validator: standardStateValidator,
      initialState: { value: "main" },
    });

    const workerNode = createWorkerNode<WorkerState>({
      instructions: "Worker",
      validator: workerStateValidator,
      initialState: { task: "bg", result: undefined },
    });

    const { executor } = createTrackingMockExecutor(() => ({
      // Both nodes return end_turn (worker should have ceded)
      yieldReason: "end_turn",
      messages: [{ role: "assistant" as const, content: "Done!" }],
    }));

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { standardNode, workerNode },
    });

    const workerChild = createInstance(workerNode, { task: "bg", result: undefined });
    const standardChild = createInstance(standardNode, { value: "main" });
    const root = createInstance(standardNode, { value: "root" }, [workerChild, standardChild]);

    const machine = createMachine(charter, { instance: root });

    // Should complete without throwing (worker end_turn is ignored with warning)
    const result = await runMachineToCompletion(machine, "test");

    // Verify warning was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Worker instance .* returned end_turn without ceding/)
    );

    // Machine should still complete (non-worker leaf's end_turn is respected)
    expect(result.done).toBe(true);

    warnSpy.mockRestore();
  });

  it("should allow worker node to use tool_use (not end_turn)", async () => {
    const standardNode = createNode<StandardState>({
      instructions: "Standard",
      validator: standardStateValidator,
      initialState: { value: "main" },
    });

    const workerNode = createWorkerNode<WorkerState>({
      instructions: "Worker",
      validator: workerStateValidator,
      initialState: { task: "bg", result: undefined },
    });

    let step = 0;
    const { executor } = createTrackingMockExecutor(
      (_charter, instance, _ancestors, _input) => {
        step++;
        if (instance.node.worker) {
          if (step === 1) {
            // First step: worker uses tool
            return {
              yieldReason: "tool_use",
              messages: [],
            };
          }
          // Second step: worker cedes
          return {
            yieldReason: "cede",
            cedePayload: { done: true },
          };
        }
        // Standard node continues then ends
        if (step <= 2) {
          return {
            yieldReason: "tool_use",
            messages: [],
          };
        }
        return {
          yieldReason: "end_turn",
          messages: [{ role: "assistant" as const, content: "Done!" }],
        };
      }
    );

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { standardNode, workerNode },
    });

    const workerChild = createInstance(workerNode, { task: "bg", result: undefined });
    const standardChild = createInstance(standardNode, { value: "main" });
    const root = createInstance(standardNode, { value: "root" }, [workerChild, standardChild]);

    const machine = createMachine(charter, { instance: root });
    const result = await runMachineToCompletion(machine, "test");

    expect(result.yieldReason).toBe("end_turn");
  });
});

describe("parallel execution cede handling", () => {
  it("should remove worker leaf when it cedes", async () => {
    const standardNode = createNode<StandardState>({
      instructions: "Standard",
      validator: standardStateValidator,
      initialState: { value: "main" },
    });

    const workerNode = createWorkerNode<WorkerState>({
      instructions: "Worker",
      validator: workerStateValidator,
      initialState: { task: "bg", result: undefined },
    });

    const { executor } = createTrackingMockExecutor(
      (_charter, instance, _ancestors, _input) => {
        if (instance.node.worker) {
          return {
            yieldReason: "cede",
            cedePayload: { result: "background done" },
          };
        }
        return {
          yieldReason: "end_turn",
          messages: [{ role: "assistant" as const, content: "Main done!" }],
        };
      }
    );

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { standardNode, workerNode },
    });

    const workerChild = createInstance(workerNode, { task: "bg", result: undefined });
    const standardChild = createInstance(standardNode, { value: "main" });
    const root = createInstance(standardNode, { value: "root" }, [workerChild, standardChild]);

    const machine = createMachine(charter, { instance: root });
    const result = await runMachineToCompletion(machine, "test");

    // After parallel execution, worker child should be removed
    expect(result.instance.children).toBeDefined();
    expect(result.instance.children?.length).toBe(1);

    // Should only have the standard child left
    const child = result.instance.children![0]!;
    expect(child.node.worker).not.toBe(true);
  });
});

describe("message attribution", () => {
  it("should attribute messages to source instances in parallel execution", async () => {
    const standardNode = createNode<StandardState>({
      instructions: "Standard",
      validator: standardStateValidator,
      initialState: { value: "main" },
    });

    const workerNode = createWorkerNode<WorkerState>({
      instructions: "Worker",
      validator: workerStateValidator,
      initialState: { task: "bg", result: undefined },
    });

    const { executor } = createTrackingMockExecutor(
      (_charter, instance, _ancestors, _input) => {
        if (instance.node.worker) {
          return {
            yieldReason: "cede",
            cedePayload: { result: "background done" },
            messages: [{ role: "assistant" as const, content: "Worker message" }],
          };
        }
        return {
          yieldReason: "end_turn",
          messages: [{ role: "assistant" as const, content: "Standard message" }],
        };
      }
    );

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { standardNode, workerNode },
    });

    const workerChild = createInstance(workerNode, { task: "bg", result: undefined });
    const standardChild = createInstance(standardNode, { value: "main" });
    const root = createInstance(standardNode, { value: "root" }, [workerChild, standardChild]);

    const machine = createMachine(charter, { instance: root });
    const steps = await collectSteps(runMachine(machine, "test"));

    // First step should contain messages from both leaves
    const firstStep = steps[0]!;
    expect(firstStep.messages.length).toBe(2);

    // Messages should have sourceInstanceId metadata
    for (const msg of firstStep.messages) {
      const metadata = (msg as { metadata?: { sourceInstanceId?: string } }).metadata;
      expect(metadata?.sourceInstanceId).toBeDefined();
    }
  });
});
