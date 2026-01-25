import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createCharter } from "../core/charter.js";
import { createNode } from "../core/node.js";
import { createInstance, getActiveInstance, getInstancePath } from "../types/instance.js";
import { createMachine } from "../core/machine.js";
import { runMachine, runMachineToCompletion } from "../core/run.js";
import { spawn } from "../helpers/cede-spawn.js";
import type { Executor, RunResult, RunOptions, MachineStep } from "../executor/types.js";
import type { Charter } from "../types/charter.js";
import type { Instance } from "../types/instance.js";
import type { CodeTransition } from "../types/transitions.js";
import type { Message } from "../types/messages.js";

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
 * Mock executor that simulates agent behavior for testing.
 * Allows us to control what the "agent" does (spawn, cede, etc.)
 */
function createMockExecutor(
  behavior: (
    charter: Charter<unknown>,
    instance: Instance,
    ancestors: Instance[],
    input: string,
  ) => Partial<RunResult<unknown>>,
): Executor<unknown> {
  return {
    type: "standard",
    run: async (
      charter: Charter<unknown>,
      instance: Instance,
      ancestors: Instance[],
      input: string,
      _options?: RunOptions<unknown>,
    ): Promise<RunResult<unknown>> => {
      const result = behavior(charter, instance, ancestors, input);
      return {
        instance: result.instance ?? instance,
        messages: result.messages ?? [],
        yieldReason: result.yieldReason ?? "end_turn",
        cedeContent: result.cedeContent,
        packStates: result.packStates,
      };
    },
  };
}

// Simple state schemas for testing
const parentStateValidator = z.object({
  value: z.string(),
});
type ParentState = z.infer<typeof parentStateValidator>;

const childStateValidator = z.object({
  query: z.string(),
  result: z.string().optional(),
});
type ChildState = z.infer<typeof childStateValidator>;

describe("spawn behavior", () => {
  it("should add a child instance when spawn is returned", async () => {
    // Create child node
    const childNode = createNode<ChildState>({
      instructions: "Child node",
      validator: childStateValidator,
      initialState: { query: "", result: undefined },
    });

    // Spawn transition
    const spawnChild: CodeTransition<ParentState> = {
      type: "code",
      description: "Spawn a child",
      execute: () => {
        return spawn(childNode, { query: "test query", result: undefined });
      },
    };

    // Create parent node
    const parentNode = createNode<ParentState>({
      instructions: "Parent node",
      validator: parentStateValidator,
      transitions: { spawnChild: { ref: "spawnChild" } },
      initialState: { value: "parent" },
    });

    // Create executor that simulates spawn
    const executor = createMockExecutor((charter, instance, _ancestors, _input) => {
      // Simulate the agent calling spawn
      const newChild = createInstance(childNode, { query: "test query", result: undefined });
      return {
        instance: {
          ...instance,
          children: [newChild],
        },
        yieldReason: "end_turn",
      };
    });

    const charter = createCharter({
      name: "test",
      executor,
      transitions: { spawnChild: spawnChild as any },
      nodes: { parentNode, childNode },
    });

    const machine = createMachine(charter, {
      instance: createInstance(parentNode, { value: "parent" }),
    });

    const result = await runMachineToCompletion(machine, "spawn a child");

    // Verify child was added
    expect(result.instance.children).toBeDefined();
    expect(result.instance.children?.length).toBe(1);
    const child = result.instance.children![0]!;
    expect(child.node.id).toBe(childNode.id);
    expect(child.state).toEqual({ query: "test query", result: undefined });
  });

  it("should make spawned child the active instance", async () => {
    const childNode = createNode<ChildState>({
      instructions: "Child node",
      validator: childStateValidator,
      initialState: { query: "", result: undefined },
    });

    const parentNode = createNode<ParentState>({
      instructions: "Parent node",
      validator: parentStateValidator,
      initialState: { value: "parent" },
    });

    // First call: spawn child
    // Second call: run on child
    let callCount = 0;
    const executor = createMockExecutor((charter, instance, _ancestors, _input) => {
      callCount++;
      if (callCount === 1) {
        // First call - spawn the child
        const newChild = createInstance(childNode, { query: "spawned", result: undefined });
        return {
          instance: { ...instance, children: [newChild] },
          yieldReason: "end_turn",
        };
      }
      return { instance, yieldReason: "end_turn" };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { parentNode, childNode },
    });

    // After spawn
    const machine1 = createMachine(charter, {
      instance: createInstance(parentNode, { value: "parent" }),
    });
    const result1 = await runMachineToCompletion(machine1, "spawn");

    // Verify child is now active
    const activePath = getInstancePath(result1.instance);
    expect(activePath.length).toBe(2);
    expect(activePath[0]?.node.id).toBe(parentNode.id);
    expect(activePath[1]?.node.id).toBe(childNode.id);

    const active = getActiveInstance(result1.instance);
    expect(active.node.id).toBe(childNode.id);
  });
});

describe("spawn continuation", () => {
  it("should continue execution on child after spawn with no response", async () => {
    const childNode = createNode<ChildState>({
      instructions: "Child node",
      validator: childStateValidator,
      initialState: { query: "", result: undefined },
    });

    const parentNode = createNode<ParentState>({
      instructions: "Parent node",
      validator: parentStateValidator,
      initialState: { value: "parent" },
    });

    let callCount = 0;
    const executor = createMockExecutor((_charter, instance, _ancestors, _input) => {
      callCount++;

      if (callCount === 1) {
        // First call: parent spawns child (tool_use because spawn is a tool)
        const newChild = createInstance(childNode, { query: "research", result: undefined });
        return {
          instance: { ...instance, children: [newChild] },
          yieldReason: "tool_use", // Spawn returns tool_use to continue on child
          messages: [],
        };
      }

      // Second call: child responds
      return {
        instance,
        yieldReason: "end_turn",
        messages: [{ role: "assistant" as const, content: "Hello, I'm the child starting my work!" }],
      };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { parentNode, childNode },
    });

    const machine = createMachine(charter, {
      instance: createInstance(parentNode, { value: "parent" }),
    });
    const result = await runMachineToCompletion(machine, "spawn researcher");

    // Should have called executor twice (parent + child)
    expect(callCount).toBe(2);

    // Child should exist
    expect(result.instance.children).toBeDefined();

    // Check yield reason
    expect(result.yieldReason).toBe("end_turn");
  });

  it("should stop if spawn has a text response", async () => {
    const childNode = createNode<ChildState>({
      instructions: "Child node",
      validator: childStateValidator,
      initialState: { query: "", result: undefined },
    });

    const parentNode = createNode<ParentState>({
      instructions: "Parent node",
      validator: parentStateValidator,
      initialState: { value: "parent" },
    });

    let callCount = 0;
    const executor = createMockExecutor((_charter, instance, _ancestors, _input) => {
      callCount++;
      // Parent spawns AND provides a response
      const newChild = createInstance(childNode, { query: "research", result: undefined });
      return {
        instance: { ...instance, children: [newChild] },
        yieldReason: "end_turn",
        messages: [{ role: "assistant" as const, content: "I've started the researcher for you!" }],
      };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { parentNode, childNode },
    });

    const machine = createMachine(charter, {
      instance: createInstance(parentNode, { value: "parent" }),
    });
    const result = await runMachineToCompletion(machine, "spawn");

    // Should only call executor once (spawn had response)
    expect(callCount).toBe(1);
    expect(result.yieldReason).toBe("end_turn");
  });

  it("should handle spawn followed by cede in same run", async () => {
    const childNode = createNode<ChildState>({
      instructions: "Child node",
      validator: childStateValidator,
      initialState: { query: "", result: undefined },
    });

    const parentNode = createNode<ParentState>({
      instructions: "Parent node",
      validator: parentStateValidator,
      initialState: { value: "parent" },
    });

    let callCount = 0;
    const executor = createMockExecutor((_charter, instance, ancestors, _input) => {
      callCount++;

      if (callCount === 1) {
        // Parent spawns child (tool_use to continue on child)
        const newChild = createInstance(childNode, { query: "quick", result: undefined });
        return {
          instance: { ...instance, children: [newChild] },
          yieldReason: "tool_use",
          messages: [],
        };
      }

      if (callCount === 2) {
        // Child immediately cedes (no response)
        return {
          instance,
          yieldReason: "cede",
          cedeContent: "Task completed",
          messages: [],
        };
      }

      // Parent responds after receiving cede
      return {
        instance,
        yieldReason: "end_turn",
        messages: [{ role: "assistant" as const, content: "The quick task is done!" }],
      };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { parentNode, childNode },
    });

    const machine = createMachine(charter, {
      instance: createInstance(parentNode, { value: "parent" }),
    });
    const result = await runMachineToCompletion(machine, "do quick task");

    // Should have called executor 3 times: spawn -> cede -> parent responds
    expect(callCount).toBe(3);

    // Child should be removed after cede
    expect(result.instance.children).toBeUndefined();

    // Verify yield reason
    expect(result.yieldReason).toBe("end_turn");
  });
});

describe("cede behavior", () => {
  it("should remove child instance when cede is returned", async () => {
    const childNode = createNode<ChildState>({
      instructions: "Child node",
      validator: childStateValidator,
      initialState: { query: "", result: undefined },
    });

    const parentNode = createNode<ParentState>({
      instructions: "Parent node",
      validator: parentStateValidator,
      initialState: { value: "parent" },
    });

    // Executor that simulates cede then parent response
    let callCount = 0;
    const executor = createMockExecutor((_charter, instance, _ancestors, _input) => {
      callCount++;
      if (callCount === 1) {
        // Child cedes
        return {
          instance,
          yieldReason: "cede",
          cedeContent: "Result: done",
          messages: [],
        };
      }
      // Parent responds
      return {
        instance,
        yieldReason: "end_turn",
        messages: [{ role: "assistant" as const, content: "Got the cede result!" }],
      };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { parentNode, childNode },
    });

    // Start with parent that already has a child
    const childInstance = createInstance(childNode, { query: "test", result: "found" });
    const parentInstance = createInstance(parentNode, { value: "parent" }, childInstance);

    const machine = createMachine(charter, {
      instance: parentInstance,
    });

    const steps = await collectSteps(runMachine(machine, "cede back"));

    // Should have 2 steps: cede then parent response
    expect(steps.length).toBe(2);

    // First step: cede
    expect(steps[0]?.yieldReason).toBe("cede");
    expect(steps[0]?.cedeContent).toBe("Result: done");
    expect(steps[0]?.instance.children).toBeUndefined(); // Child removed after cede

    // Second step: parent responds
    expect(steps[1]?.yieldReason).toBe("end_turn");

    // Parent should be the active instance
    const active = getActiveInstance(steps[1]!.instance);
    expect(active.node.id).toBe(parentNode.id);
  });

  it("should return cede payload in step", async () => {
    const childNode = createNode<ChildState>({
      instructions: "Child node",
      validator: childStateValidator,
      initialState: { query: "", result: undefined },
    });

    const parentNode = createNode<ParentState>({
      instructions: "Parent node",
      validator: parentStateValidator,
      initialState: { value: "parent" },
    });

    let callCount = 0;
    const executor = createMockExecutor((_charter, instance, _ancestors, _input) => {
      callCount++;
      if (callCount === 1) {
        return {
          instance,
          yieldReason: "cede",
          cedeContent: "Findings: item1, item2 (query: test)",
          messages: [],
        };
      }
      return {
        instance,
        yieldReason: "end_turn",
        messages: [{ role: "assistant" as const, content: "Done!" }],
      };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { parentNode, childNode },
    });

    const childInstance = createInstance(childNode, { query: "test", result: undefined });
    const parentInstance = createInstance(parentNode, { value: "parent" }, childInstance);

    const machine = createMachine(charter, { instance: parentInstance });
    const steps = await collectSteps(runMachine(machine, "complete"));

    // Cede content is on the cede step
    expect(steps[0]?.cedeContent).toBe("Findings: item1, item2 (query: test)");
  });

  it("should work with nested spawn/cede cycle", async () => {
    const childNode = createNode<ChildState>({
      instructions: "Child node",
      validator: childStateValidator,
      initialState: { query: "", result: undefined },
    });

    const parentNode = createNode<ParentState>({
      instructions: "Parent node",
      validator: parentStateValidator,
      initialState: { value: "parent" },
    });

    let step = 0;
    const executor = createMockExecutor((_charter, instance, ancestors, _input) => {
      step++;

      if (step === 1) {
        // Step 1: Parent spawns child
        const newChild = createInstance(childNode, { query: "research", result: undefined });
        return {
          instance: { ...instance, children: [newChild] },
          yieldReason: "end_turn",
        };
      }

      if (step === 2) {
        // Step 2: Child does work (runs on child since it's active)
        return {
          instance: { ...instance, state: { query: "research", result: "found stuff" } },
          yieldReason: "end_turn",
        };
      }

      if (step === 3) {
        // Step 3: Child cedes back with results (no response)
        return {
          instance,
          yieldReason: "cede",
          cedeContent: "Result: found stuff",
          messages: [],
        };
      }

      // Step 4: Parent responds after receiving cede
      return {
        instance,
        yieldReason: "end_turn",
        messages: [{ role: "assistant" as const, content: "Research complete!" }],
      };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { parentNode, childNode },
    });

    // Step 1: Spawn
    const machine1 = createMachine(charter, {
      instance: createInstance(parentNode, { value: "parent" }),
    });
    const result1 = await runMachineToCompletion(machine1, "spawn child");

    expect(result1.instance.children).toBeDefined();
    expect(getActiveInstance(result1.instance).node.id).toBe(childNode.id);

    // Step 2: Child works
    const machine2 = createMachine(charter, {
      instance: result1.instance,
    });
    const result2 = await runMachineToCompletion(machine2, "do research");

    expect(result2.instance.children).toBeDefined();
    const childAfterWork = result2.instance.children![0]!;
    expect(childAfterWork.state).toEqual({ query: "research", result: "found stuff" });

    // Step 3: Child cedes - use collectSteps to see intermediate cede step
    const machine3 = createMachine(charter, {
      instance: result2.instance,
    });
    const steps3 = await collectSteps(runMachine(machine3, "cede results"));

    // Should have 2 steps: cede then parent response
    expect(steps3.length).toBe(2);

    // First step: cede with content
    expect(steps3[0]?.yieldReason).toBe("cede");
    expect(steps3[0]?.cedeContent).toBe("Result: found stuff");
    expect(steps3[0]?.instance.children).toBeUndefined(); // Child removed

    // Final step: parent responds
    const result3 = steps3[1]!;
    expect(result3.yieldReason).toBe("end_turn");
    expect(getActiveInstance(result3.instance).node.id).toBe(parentNode.id);
  });
});

describe("cede continuation", () => {
  it("should continue execution on parent after cede with no response", async () => {
    const childNode = createNode<ChildState>({
      instructions: "Child node",
      validator: childStateValidator,
      initialState: { query: "", result: undefined },
    });

    const parentNode = createNode<ParentState>({
      instructions: "Parent node",
      validator: parentStateValidator,
      initialState: { value: "parent" },
    });

    let callCount = 0;
    const executor = createMockExecutor((_charter, instance, ancestors, _input) => {
      callCount++;

      if (callCount === 1) {
        // First call: child cedes with no text response
        return {
          instance,
          yieldReason: "cede",
          cedeContent: "Result: findings",
          messages: [],
        };
      }

      // Second call: parent responds (after receiving cede content)
      return {
        instance,
        yieldReason: "end_turn",
        messages: [{ role: "assistant" as const, content: "Here are the results from the child!" }],
      };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { parentNode, childNode },
    });

    // Start with parent that has a child
    const childInstance = createInstance(childNode, { query: "test", result: undefined });
    const parentInstance = createInstance(parentNode, { value: "parent" }, childInstance);

    const machine = createMachine(charter, { instance: parentInstance });
    const result = await runMachineToCompletion(machine, "complete research");

    // Should have called executor twice
    expect(callCount).toBe(2);

    // Child should be removed
    expect(result.instance.children).toBeUndefined();

    // Verify yield reason
    expect(result.yieldReason).toBe("end_turn");
  });

  it("should include text response in cede step", async () => {
    const childNode = createNode<ChildState>({
      instructions: "Child node",
      validator: childStateValidator,
      initialState: { query: "", result: undefined },
    });

    const parentNode = createNode<ParentState>({
      instructions: "Parent node",
      validator: parentStateValidator,
      initialState: { value: "parent" },
    });

    let callCount = 0;
    const executor = createMockExecutor((_charter, instance, _ancestors, _input) => {
      callCount++;
      if (callCount === 1) {
        // Child cedes WITH a text response
        return {
          instance,
          yieldReason: "cede",
          cedeContent: "Result: findings",
          messages: [{ role: "assistant" as const, content: "I'm done with my research!" }],
        };
      }
      // Parent responds
      return {
        instance,
        yieldReason: "end_turn",
        messages: [{ role: "assistant" as const, content: "Thanks for the results!" }],
      };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { parentNode, childNode },
    });

    const childInstance = createInstance(childNode, { query: "test", result: undefined });
    const parentInstance = createInstance(parentNode, { value: "parent" }, childInstance);

    const machine = createMachine(charter, { instance: parentInstance });
    const steps = await collectSteps(runMachine(machine, "complete"));

    // Should have 2 steps: cede (with text response) then parent
    expect(steps.length).toBe(2);

    // Cede step includes the text response
    expect(steps[0]?.yieldReason).toBe("cede");
    expect(steps[0]?.cedeContent).toBe("Result: findings");
    expect(steps[0]?.done).toBe(false); // Cede always continues

    // Parent responds
    expect(steps[1]?.yieldReason).toBe("end_turn");
  });

  it("should throw error if max steps exceeded", async () => {
    // Need 3 levels so we can have multiple cedes before hitting root
    const level3Validator = z.object({ depth: z.literal(3) });
    const level2Validator = z.object({ depth: z.literal(2) });
    const level1Validator = z.object({ depth: z.literal(1) });

    const level3Node = createNode({
      instructions: "Level 3 (deepest)",
      validator: level3Validator,
      initialState: { depth: 3 as const },
    });

    const level2Node = createNode({
      instructions: "Level 2",
      validator: level2Validator,
      initialState: { depth: 2 as const },
    });

    const level1Node = createNode({
      instructions: "Level 1 (root)",
      validator: level1Validator,
      initialState: { depth: 1 as const },
    });

    // Executor that always cedes with no response
    const executor = createMockExecutor((_charter, instance, _ancestors, _input) => {
      return {
        instance,
        yieldReason: "cede",
        cedeContent: "Done",
        messages: [],
      };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { level1Node, level2Node, level3Node },
    });

    // Create 3-level deep tree: level1 -> level2 -> level3
    const level3Instance = createInstance(level3Node, { depth: 3 as const });
    const level2Instance = createInstance(level2Node, { depth: 2 as const }, level3Instance);
    const level1Instance = createInstance(level1Node, { depth: 1 as const }, level2Instance);

    const machine = createMachine(charter, { instance: level1Instance });

    // With maxSteps: 2, we get:
    // Step 1: level3 cedes → level2 active
    // Step 2: level2 cedes → level1 active
    // Step 3: level1 cedes → ERROR (root can't cede)
    // So with maxSteps: 2, we should hit max before root tries to cede
    await expect(runMachineToCompletion(machine, "loop", { maxSteps: 2 })).rejects.toThrow(
      "Max steps (2) exceeded"
    );
  });

  it("should include cede payload in step", async () => {
    const childNode = createNode<ChildState>({
      instructions: "Child node",
      validator: childStateValidator,
      initialState: { query: "", result: undefined },
    });

    const parentNode = createNode<ParentState>({
      instructions: "Parent node",
      validator: parentStateValidator,
      initialState: { value: "parent" },
    });

    let callCount = 0;
    const executor = createMockExecutor((_charter, instance, _ancestors, _input) => {
      callCount++;

      if (callCount === 1) {
        return {
          instance,
          yieldReason: "cede",
          cedeContent: "Findings: item1, item2",
          messages: [{ role: "assistant" as const, content: "Calling cede..." }],
        };
      }

      return {
        instance,
        yieldReason: "end_turn",
        messages: [{ role: "assistant" as const, content: "Got the results!" }],
      };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { parentNode, childNode },
    });

    const childInstance = createInstance(childNode, { query: "test", result: undefined });
    const parentInstance = createInstance(parentNode, { value: "parent" }, childInstance);

    const machine = createMachine(charter, { instance: parentInstance });
    const steps = await collectSteps(runMachine(machine, "do work"));

    // Should have 2 steps: cede then parent response
    expect(steps.length).toBe(2);

    // First step: cede with content
    expect(steps[0]?.yieldReason).toBe("cede");
    expect(steps[0]?.cedeContent).toBe("Findings: item1, item2");
    expect(steps[0]?.messages).toEqual([
      expect.objectContaining({ role: "assistant", content: "Calling cede..." }),
    ]);
    expect(steps[0]?.done).toBe(false);

    // Second step: parent responds
    expect(steps[1]?.yieldReason).toBe("end_turn");
    expect(steps[1]?.messages).toEqual([
      expect.objectContaining({ role: "assistant", content: "Got the results!" }),
    ]);
    expect(steps[1]?.done).toBe(true);
  });
});

describe("instance path tracking", () => {
  it("should correctly track path from root to active leaf", () => {
    const grandchildNode = createNode({
      instructions: "Grandchild",
      validator: z.object({ x: z.number() }),
      initialState: { x: 3 },
    });

    const childNode = createNode({
      instructions: "Child",
      validator: z.object({ x: z.number() }),
      initialState: { x: 2 },
    });

    const parentNode = createNode({
      instructions: "Parent",
      validator: z.object({ x: z.number() }),
      initialState: { x: 1 },
    });

    const grandchild = createInstance(grandchildNode, { x: 3 });
    const child = createInstance(childNode, { x: 2 }, grandchild);
    const parent = createInstance(parentNode, { x: 1 }, child);

    const path = getInstancePath(parent);

    expect(path.length).toBe(3);
    expect(path[0]?.state).toEqual({ x: 1 });
    expect(path[1]?.state).toEqual({ x: 2 });
    expect(path[2]?.state).toEqual({ x: 3 });
  });

  it("should follow last child when multiple children exist", () => {
    const childNode = createNode({
      instructions: "Child",
      validator: z.object({ id: z.number() }),
      initialState: { id: 0 },
    });

    const parentNode = createNode({
      instructions: "Parent",
      validator: z.object({ x: z.number() }),
      initialState: { x: 1 },
    });

    const child1 = createInstance(childNode, { id: 1 });
    const child2 = createInstance(childNode, { id: 2 });
    const child3 = createInstance(childNode, { id: 3 });
    const parent = createInstance(parentNode, { x: 1 }, [child1, child2, child3]);

    const active = getActiveInstance(parent);
    expect(active.state).toEqual({ id: 3 });

    const path = getInstancePath(parent);
    expect(path.length).toBe(2);
    expect(path[1]?.state).toEqual({ id: 3 });
  });
});
