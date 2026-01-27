import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createCharter } from "../core/charter.js";
import { createNode } from "../core/node.js";
import { createInstance, getActiveInstance, getInstancePath } from "../types/instance.js";
import { createMachine } from "../core/machine.js";
import { runMachine, runMachineToCompletion } from "../core/run.js";
import { spawn } from "../helpers/cede-spawn.js";
import type { Executor, RunResult, RunOptions, MachineStep, YieldReason } from "../executor/types.js";
import type { Charter } from "../types/charter.js";
import type { Instance } from "../types/instance.js";
import type { CodeTransition } from "../types/transitions.js";
import type { MachineMessage, InstancePayload } from "../types/messages.js";
import { userMessage, assistantMessage, instanceMessage } from "../types/messages.js";

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
 * Legacy behavior result for mock executors (pre-refactor format).
 */
interface LegacyBehaviorResult {
  instance?: Instance;
  history?: MachineMessage<unknown>[];
  yieldReason?: YieldReason;
  cedeContent?: string | MachineMessage<unknown>[];
  packStates?: Record<string, unknown>;
}

/**
 * Mock executor that simulates agent behavior for testing.
 * Uses the new enqueue-based flow internally but accepts legacy behavior format.
 */
function createMockExecutor(
  behavior: (
    charter: Charter<unknown>,
    instance: Instance,
    ancestors: Instance[],
    input: string,
  ) => LegacyBehaviorResult,
): Executor<unknown> {
  return {
    type: "standard",
    run: async (
      charter: Charter<unknown>,
      instance: Instance,
      ancestors: Instance[],
      input: string,
      options?: RunOptions<unknown>,
    ): Promise<RunResult<unknown>> => {
      const enqueue = options?.enqueue;
      if (!enqueue) {
        throw new Error("Mock executor requires options.enqueue");
      }

      const source = {
        instanceId: options?.instanceId ?? instance.id,
        isPrimary: !(options?.isWorker ?? false),
      };

      const result = behavior(charter, instance, ancestors, input);
      
      // Enqueue assistant message if history provided
      if (result.history && result.history.length > 0) {
        for (const msg of result.history) {
          enqueue([{ ...msg, metadata: { ...msg.metadata, source } }]);
        }
      } else {
        // Default: enqueue an empty assistant message
        enqueue([assistantMessage("", source)]);
      }

      // Convert instance changes to instance messages
      if (result.instance && result.instance !== instance) {
        // Check if children changed (spawn)
        if (result.instance.children && 
            (!instance.children || result.instance.children.length > instance.children.length)) {
          const newChildren = result.instance.children.slice(instance.children?.length ?? 0);
          enqueue([instanceMessage({
            kind: "spawn",
            parentInstanceId: instance.id,
            children: newChildren.map(c => ({
              node: c.node,
              state: c.state,
              executorConfig: c.executorConfig,
            })),
          }, source)]);
        }
        
        // Check if state changed
        if (result.instance.state !== instance.state) {
          enqueue([instanceMessage({
            kind: "state",
            instanceId: instance.id,
            patch: result.instance.state as Record<string, unknown>,
          }, source)]);
        }
      }

      // Handle cede
      if (result.yieldReason === "cede") {
        enqueue([instanceMessage({
          kind: "cede",
          instanceId: instance.id,
          content: result.cedeContent,
        }, source)]);
      }

      return {
        yieldReason: result.yieldReason ?? "end_turn",
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
    machine.enqueue([userMessage("spawn a child")]);

    const result = await runMachineToCompletion(machine);

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
    machine1.enqueue([userMessage("spawn")]);
    const result1 = await runMachineToCompletion(machine1);

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
          history: [],
        };
      }

      // Second call: child responds
      return {
        instance,
        yieldReason: "end_turn",
        history: [{ role: "assistant" as const, items: "Hello, I'm the child starting my work!" }],
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
    machine.enqueue([userMessage("spawn researcher")]);
    const result = await runMachineToCompletion(machine);

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
        history: [{ role: "assistant" as const, items: "I've started the researcher for you!" }],
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
    machine.enqueue([userMessage("spawn")]);
    const result = await runMachineToCompletion(machine);

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
          history: [],
        };
      }

      if (callCount === 2) {
        // Child immediately cedes (no response)
        return {
          instance,
          yieldReason: "cede",
          cedeContent: "Task completed",
          history: [],
        };
      }

      // Parent responds after receiving cede
      return {
        instance,
        yieldReason: "end_turn",
        history: [{ role: "assistant" as const, items: "The quick task is done!" }],
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
    machine.enqueue([userMessage("do quick task")]);
    const result = await runMachineToCompletion(machine);

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
          history: [],
        };
      }
      // Parent responds
      return {
        instance,
        yieldReason: "end_turn",
        history: [{ role: "assistant" as const, items: "Got the cede result!" }],
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
    machine.enqueue([userMessage("cede back")]);

    const steps = await collectSteps(runMachine(machine));

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
          history: [],
        };
      }
      return {
        instance,
        yieldReason: "end_turn",
        history: [{ role: "assistant" as const, items: "Done!" }],
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
    machine.enqueue([userMessage("complete")]);
    const steps = await collectSteps(runMachine(machine));

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
          history: [],
        };
      }

      // Step 4: Parent responds after receiving cede
      return {
        instance,
        yieldReason: "end_turn",
        history: [{ role: "assistant" as const, items: "Research complete!" }],
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
    machine1.enqueue([userMessage("spawn child")]);
    const result1 = await runMachineToCompletion(machine1);

    expect(result1.instance.children).toBeDefined();
    expect(getActiveInstance(result1.instance).node.id).toBe(childNode.id);

    // Step 2: Child works
    const machine2 = createMachine(charter, {
      instance: result1.instance,
    });
    machine2.enqueue([userMessage("do research")]);
    const result2 = await runMachineToCompletion(machine2);

    expect(result2.instance.children).toBeDefined();
    const childAfterWork = result2.instance.children![0]!;
    expect(childAfterWork.state).toEqual({ query: "research", result: "found stuff" });

    // Step 3: Child cedes - use collectSteps to see intermediate cede step
    const machine3 = createMachine(charter, {
      instance: result2.instance,
    });
    machine3.enqueue([userMessage("cede results")]);
    const steps3 = await collectSteps(runMachine(machine3));

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
          history: [],
        };
      }

      // Second call: parent responds (after receiving cede content)
      return {
        instance,
        yieldReason: "end_turn",
        history: [{ role: "assistant" as const, items: "Here are the results from the child!" }],
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
    machine.enqueue([userMessage("complete research")]);
    const result = await runMachineToCompletion(machine);

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
          history: [{ role: "assistant" as const, items: "I'm done with my research!" }],
        };
      }
      // Parent responds
      return {
        instance,
        yieldReason: "end_turn",
        history: [{ role: "assistant" as const, items: "Thanks for the results!" }],
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
    machine.enqueue([userMessage("complete")]);
    const steps = await collectSteps(runMachine(machine));

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
        history: [],
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
    machine.enqueue([userMessage("loop")]);

    // With maxSteps: 2, we get:
    // Step 1: level3 cedes → level2 active
    // Step 2: level2 cedes → level1 active
    // Step 3: level1 cedes → ERROR (root can't cede)
    // So with maxSteps: 2, we should hit max before root tries to cede
    await expect(runMachineToCompletion(machine, { maxSteps: 2 })).rejects.toThrow(
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
          history: [{ role: "assistant" as const, items: "Calling cede..." }],
        };
      }

      return {
        instance,
        yieldReason: "end_turn",
        history: [{ role: "assistant" as const, items: "Got the results!" }],
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
    machine.enqueue([userMessage("do work")]);
    const steps = await collectSteps(runMachine(machine));

    // Should have 2 steps: cede then parent response
    expect(steps.length).toBe(2);

    // First step: cede with content (user input is in machine.history, not step history)
    expect(steps[0]?.yieldReason).toBe("cede");
    expect(steps[0]?.cedeContent).toBe("Findings: item1, item2");
    // Step history only contains messages generated during the step
    expect(steps[0]?.history.some(m => m.role === "assistant")).toBe(true);
    expect(steps[0]?.done).toBe(false);

    // Second step: parent responds
    expect(steps[1]?.yieldReason).toBe("end_turn");
    expect(steps[1]?.history.some(m => m.role === "assistant")).toBe(true);
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
