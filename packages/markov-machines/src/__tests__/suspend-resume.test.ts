import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createCharter } from "../core/charter.js";
import { createNode } from "../core/node.js";
import { createInstance, getActiveInstance, getActiveLeaves, getSuspendedInstances, findInstanceById } from "../types/instance.js";
import { createMachine } from "../core/machine.js";
import { runMachine, runMachineToCompletion } from "../core/run.js";
import { runCommand } from "../core/commands.js";
import { suspend } from "../helpers/cede-spawn.js";
import { commandResume, commandResult } from "../types/commands.js";
import type { Executor, RunResult, RunOptions, MachineStep, SuspendedInstanceInfo, YieldReason } from "../executor/types.js";
import type { Charter } from "../types/charter.js";
import type { Instance, SuspendInfo } from "../types/instance.js";
import type { Resume, Command } from "../types/commands.js";
import type { MachineMessage } from "../types/messages.js";
import { userMessage, systemMessage, assistantMessage, instanceMessage } from "../types/messages.js";

/**
 * Helper to collect all steps from the async generator.
 */
async function collectSteps<T = unknown>(
  generator: AsyncGenerator<MachineStep<T>>,
): Promise<MachineStep<T>[]> {
  const steps: MachineStep<T>[] = [];
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
 * Uses the new enqueue-based flow.
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
      
      // Enqueue assistant message
      if (result.history && result.history.length > 0) {
        for (const msg of result.history) {
          enqueue([{ ...msg, metadata: { ...msg.metadata, source } }]);
        }
      } else {
        enqueue([assistantMessage("", source)]);
      }

      // Convert instance changes to instance messages
      if (result.instance && result.instance !== instance) {
        // Check if suspended
        if (result.instance.suspended && !instance.suspended) {
          enqueue([instanceMessage({
            kind: "suspend",
            instanceId: instance.id,
            suspendInfo: result.instance.suspended,
          }, source)]);
        }
        
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

      // Handle suspend yield reason
      if (result.yieldReason === "suspend") {
        // Check if instance has suspended info from transition
        if (result.instance?.suspended) {
          enqueue([instanceMessage({
            kind: "suspend",
            instanceId: instance.id,
            suspendInfo: result.instance.suspended,
          }, source)]);
        }
      }

      return {
        yieldReason: result.yieldReason ?? "end_turn",
      };
    },
  };
}

// State schemas for testing
const nodeStateValidator = z.object({
  value: z.string(),
});
type NodeState = z.infer<typeof nodeStateValidator>;

describe("suspend helper", () => {
  it("should create a SuspendResult with generated suspendId", () => {
    const result = suspend("Test reason");

    expect(result.type).toBe("suspend");
    expect(result.suspendId).toBeDefined();
    expect(result.suspendId.length).toBeGreaterThan(0);
    expect(result.reason).toBe("Test reason");
    expect(result.metadata).toBeUndefined();
  });

  it("should create a SuspendResult with custom suspendId", () => {
    const result = suspend("Custom ID test", { suspendId: "custom-123" });

    expect(result.type).toBe("suspend");
    expect(result.suspendId).toBe("custom-123");
    expect(result.reason).toBe("Custom ID test");
  });

  it("should create a SuspendResult with metadata", () => {
    const result = suspend("With metadata", {
      metadata: { action: "approve", amount: 100 },
    });

    expect(result.type).toBe("suspend");
    expect(result.metadata).toEqual({ action: "approve", amount: 100 });
  });
});

describe("getActiveLeaves filtering", () => {
  it("should exclude suspended instances", () => {
    const node = createNode<NodeState>({
      instructions: "Test node",
      validator: nodeStateValidator,
      initialState: { value: "test" },
    });

    const suspendInfo: SuspendInfo = {
      suspendId: "suspend-123",
      reason: "Awaiting approval",
      suspendedAt: new Date(),
    };

    const suspendedInstance: Instance = {
      ...createInstance(node, { value: "suspended" }),
      suspended: suspendInfo,
    };

    const activeLeaves = getActiveLeaves(suspendedInstance);
    expect(activeLeaves.length).toBe(0);
  });

  it("should return non-suspended leaves", () => {
    const node = createNode<NodeState>({
      instructions: "Test node",
      validator: nodeStateValidator,
      initialState: { value: "test" },
    });

    const normalInstance = createInstance(node, { value: "normal" });
    const activeLeaves = getActiveLeaves(normalInstance);
    expect(activeLeaves.length).toBe(1);
  });

  it("should filter suspended children but include non-suspended ones", () => {
    const childNode = createNode<NodeState>({
      instructions: "Child node",
      validator: nodeStateValidator,
      initialState: { value: "child" },
    });

    const parentNode = createNode<NodeState>({
      instructions: "Parent node",
      validator: nodeStateValidator,
      initialState: { value: "parent" },
    });

    const suspendedChild: Instance = {
      ...createInstance(childNode, { value: "suspended" }),
      suspended: {
        suspendId: "s1",
        reason: "Suspended",
        suspendedAt: new Date(),
      },
    };

    const activeChild = createInstance(childNode, { value: "active" });

    const parent = createInstance(parentNode, { value: "parent" }, [suspendedChild, activeChild]);

    const activeLeaves = getActiveLeaves(parent);
    expect(activeLeaves.length).toBe(1);
    expect(activeLeaves[0]?.path[1]?.state).toEqual({ value: "active" });
  });
});

describe("getSuspendedInstances", () => {
  it("should return all suspended instances in tree", () => {
    const node = createNode<NodeState>({
      instructions: "Test node",
      validator: nodeStateValidator,
      initialState: { value: "test" },
    });

    const child1: Instance = {
      ...createInstance(node, { value: "child1" }),
      suspended: {
        suspendId: "s1",
        reason: "Reason 1",
        suspendedAt: new Date(),
      },
    };

    const child2: Instance = {
      ...createInstance(node, { value: "child2" }),
      suspended: {
        suspendId: "s2",
        reason: "Reason 2",
        suspendedAt: new Date(),
      },
    };

    const child3 = createInstance(node, { value: "child3" });

    const parent = createInstance(node, { value: "parent" }, [child1, child2, child3]);

    const suspended = getSuspendedInstances(parent);
    expect(suspended.length).toBe(2);
    expect(suspended.map(s => s.state)).toContainEqual({ value: "child1" });
    expect(suspended.map(s => s.state)).toContainEqual({ value: "child2" });
  });
});

describe("findInstanceById", () => {
  it("should find an instance by id", () => {
    const node = createNode<NodeState>({
      instructions: "Test node",
      validator: nodeStateValidator,
      initialState: { value: "test" },
    });

    const child = createInstance(node, { value: "child" });
    const parent = createInstance(node, { value: "parent" }, child);

    const found = findInstanceById(parent, child.id);
    expect(found).toBeDefined();
    expect(found?.state).toEqual({ value: "child" });
  });

  it("should return undefined for non-existent id", () => {
    const node = createNode<NodeState>({
      instructions: "Test node",
      validator: nodeStateValidator,
      initialState: { value: "test" },
    });

    const instance = createInstance(node, { value: "test" });
    const found = findInstanceById(instance, "non-existent-id");
    expect(found).toBeUndefined();
  });
});

describe("all-suspended state", () => {
  it("should yield awaiting_resume when all leaves are suspended", async () => {
    const node = createNode<NodeState>({
      instructions: "Test node",
      validator: nodeStateValidator,
      initialState: { value: "test" },
    });

    // Executor that returns already-suspended instance
    const executor = createMockExecutor((_charter, instance, _ancestors, _input) => {
      const suspendedInstance: Instance = {
        ...instance,
        suspended: {
          suspendId: "suspend-456",
          reason: "Awaiting approval",
          suspendedAt: new Date(),
        },
      };
      return {
        instance: suspendedInstance,
        yieldReason: "end_turn",
        history: [],
      };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { node },
    });

    const machine = createMachine(charter, {
      instance: createInstance(node, { value: "test" }),
    });

    // First run: executor returns, then machine checks leaves
    machine.enqueue([userMessage("test input")]);
    const step1 = await runMachineToCompletion(machine);
    expect(step1.instance.suspended).toBeDefined();

    // Second run: all leaves are suspended
    const machine2 = createMachine(charter, {
      instance: step1.instance,
    });
    machine2.enqueue([userMessage("another input")]);
    const step2 = await runMachineToCompletion(machine2);

    expect(step2.yieldReason).toBe("awaiting_resume");
    expect(step2.done).toBe(true);
    expect(step2.suspendedInstances).toBeDefined();
    expect(step2.suspendedInstances?.length).toBe(1);
    expect(step2.suspendedInstances?.[0]?.suspendId).toBe("suspend-456");
    expect(step2.suspendedInstances?.[0]?.reason).toBe("Awaiting approval");
  });
});

describe("Resume input", () => {
  it("should resume a suspended instance via Resume input", async () => {
    const node = createNode<NodeState>({
      instructions: "Test node",
      validator: nodeStateValidator,
      initialState: { value: "test" },
    });

    const executor = createMockExecutor((_charter, instance, _ancestors, _input) => {
      return {
        instance,
        yieldReason: "end_turn",
        history: [{ role: "assistant" as const, items: "Hello!" }],
      };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { node },
    });

    // Create a suspended instance
    const suspendedInstance: Instance = {
      ...createInstance(node, { value: "test" }),
      suspended: {
        suspendId: "suspend-789",
        reason: "Paused",
        suspendedAt: new Date(),
      },
    };

    const machine = createMachine(charter, {
      instance: suspendedInstance,
    });

    // Resume the instance
    const resume: Resume = {
      type: "resume",
      instanceId: suspendedInstance.id,
      suspendId: "suspend-789",
    };

    machine.enqueue([systemMessage([resume])]);
    const steps = await collectSteps(runMachine(machine));

    expect(steps.length).toBe(1);
    expect(steps[0]?.instance.suspended).toBeUndefined();
    expect(steps[0]?.yieldReason).toBe("command");
    expect(steps[0]?.done).toBe(false); // Not done - should continue execution
  });

  it("should throw error for mismatched suspendId", async () => {
    const node = createNode<NodeState>({
      instructions: "Test node",
      validator: nodeStateValidator,
      initialState: { value: "test" },
    });

    const executor = createMockExecutor((_charter, instance, _ancestors, _input) => {
      return { instance, yieldReason: "end_turn" };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { node },
    });

    const suspendedInstance: Instance = {
      ...createInstance(node, { value: "test" }),
      suspended: {
        suspendId: "correct-id",
        reason: "Paused",
        suspendedAt: new Date(),
      },
    };

    const machine = createMachine(charter, {
      instance: suspendedInstance,
    });

    const resume: Resume = {
      type: "resume",
      instanceId: suspendedInstance.id,
      suspendId: "wrong-id",
    };

    machine.enqueue([systemMessage([resume])]);
    await expect(
      collectSteps(runMachine(machine))
    ).rejects.toThrow("Suspend ID mismatch");
  });

  it("should throw error for non-suspended instance", async () => {
    const node = createNode<NodeState>({
      instructions: "Test node",
      validator: nodeStateValidator,
      initialState: { value: "test" },
    });

    const executor = createMockExecutor((_charter, instance, _ancestors, _input) => {
      return { instance, yieldReason: "end_turn" };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { node },
    });

    const instance = createInstance(node, { value: "test" });
    const machine = createMachine(charter, { instance });

    const resume: Resume = {
      type: "resume",
      instanceId: instance.id,
      suspendId: "any-id",
    };

    machine.enqueue([systemMessage([resume])]);
    await expect(
      collectSteps(runMachine(machine))
    ).rejects.toThrow("is not suspended");
  });
});

describe("command with suspend", () => {
  it("should suspend via command", async () => {
    const node = createNode<NodeState>({
      instructions: "Test node",
      validator: nodeStateValidator,
      initialState: { value: "test" },
      commands: {
        pauseTask: {
          name: "pauseTask",
          description: "Pause the task",
          inputSchema: z.object({ reason: z.string() }),
          execute: (input, ctx) => {
            return ctx.suspend(input.reason, { metadata: { paused: true } });
          },
        },
      },
    });

    const executor = createMockExecutor((_charter, instance, _ancestors, _input) => {
      return { instance, yieldReason: "end_turn" };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { node },
    });

    const machine = createMachine(charter, {
      instance: createInstance(node, { value: "test" }),
    });

    const { machine: updatedMachine, result } = await runCommand(
      machine,
      "pauseTask",
      { reason: "Need approval" },
    );

    expect(result.success).toBe(true);
    expect(updatedMachine.instance.suspended).toBeDefined();
    expect(updatedMachine.instance.suspended?.reason).toBe("Need approval");
    expect(updatedMachine.instance.suspended?.metadata).toEqual({ paused: true });
  });
});

describe("command with resume", () => {
  it("should resume via command returning ResumeResult", async () => {
    const node = createNode<NodeState>({
      instructions: "Test node",
      validator: nodeStateValidator,
      initialState: { value: "test" },
      commands: {
        approve: {
          name: "approve",
          description: "Approve and resume",
          inputSchema: z.object({}),
          execute: (_input, ctx) => {
            ctx.updateState({ value: "approved" });
            return commandResume();
          },
        },
      },
    });

    const executor = createMockExecutor((_charter, instance, _ancestors, _input) => {
      return { instance, yieldReason: "end_turn" };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { node },
    });

    // Start with suspended instance
    const suspendedInstance: Instance = {
      ...createInstance(node, { value: "pending" }),
      suspended: {
        suspendId: "s-123",
        reason: "Waiting",
        suspendedAt: new Date(),
      },
    };

    const machine = createMachine(charter, {
      instance: suspendedInstance,
    });

    // Run command on suspended instance
    const { machine: updatedMachine, result } = await runCommand(
      machine,
      "approve",
      {},
      suspendedInstance.id,
    );

    expect(result.success).toBe(true);
    expect(updatedMachine.instance.suspended).toBeUndefined();
    expect(updatedMachine.instance.state).toEqual({ value: "approved" });
  });
});

describe("command with instanceId targeting", () => {
  it("should target specific instance with instanceId", async () => {
    const node = createNode<NodeState>({
      instructions: "Test node",
      validator: nodeStateValidator,
      initialState: { value: "test" },
      commands: {
        setValue: {
          name: "setValue",
          description: "Set value",
          inputSchema: z.object({ newValue: z.string() }),
          execute: (input, ctx) => {
            ctx.updateState({ value: input.newValue });
            return commandResult("ok");
          },
        },
      },
    });

    const executor = createMockExecutor((_charter, instance, _ancestors, _input) => {
      return { instance, yieldReason: "end_turn" };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { node },
    });

    const child = createInstance(node, { value: "child" });
    const parent = createInstance(node, { value: "parent" }, child);

    const machine = createMachine(charter, { instance: parent });

    // Target the parent specifically (not the active child)
    const { machine: updatedMachine, result } = await runCommand(
      machine,
      "setValue",
      { newValue: "updated-parent" },
      parent.id,
    );

    expect(result.success).toBe(true);
    expect(updatedMachine.instance.state).toEqual({ value: "updated-parent" });
    // Child should be unchanged
    expect(updatedMachine.instance.children?.[0]?.state).toEqual({ value: "child" });
  });
});

describe("serialization with suspend", () => {
  it("should serialize and deserialize suspended instance", async () => {
    const { serializeInstance } = await import("../serialization/serialize.js");
    const { deserializeInstance } = await import("../serialization/deserialize.js");

    const node = createNode<NodeState>({
      instructions: "Test node",
      validator: nodeStateValidator,
      initialState: { value: "test" },
    });

    const executor = createMockExecutor((_charter, instance, _ancestors, _input) => {
      return { instance, yieldReason: "end_turn" };
    });

    const charter = createCharter({
      name: "test",
      executor,
      nodes: { testNode: node },
    });

    const suspendedAt = new Date("2024-01-15T10:30:00Z");
    const suspendedInstance: Instance = {
      ...createInstance(node, { value: "suspended" }),
      suspended: {
        suspendId: "s-serialize-test",
        reason: "Testing serialization",
        suspendedAt,
        metadata: { foo: "bar" },
      },
    };

    // Serialize
    const serialized = serializeInstance(suspendedInstance, charter);
    expect(serialized.suspended).toBeDefined();
    expect(serialized.suspended?.suspendId).toBe("s-serialize-test");
    expect(serialized.suspended?.reason).toBe("Testing serialization");
    expect(serialized.suspended?.suspendedAt).toBe("2024-01-15T10:30:00.000Z");
    expect(serialized.suspended?.metadata).toEqual({ foo: "bar" });

    // Deserialize
    const deserialized = deserializeInstance(charter, serialized);
    expect(deserialized.suspended).toBeDefined();
    expect(deserialized.suspended?.suspendId).toBe("s-serialize-test");
    expect(deserialized.suspended?.reason).toBe("Testing serialization");
    expect(deserialized.suspended?.suspendedAt).toEqual(suspendedAt);
    expect(deserialized.suspended?.metadata).toEqual({ foo: "bar" });
  });
});
