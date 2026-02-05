import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createCharter } from "../core/charter";
import { createNode } from "../core/node";
import { createInstance } from "../types/instance";
import { createMachine } from "../core/machine";
import { runMachineToCompletion } from "../core/run";
import { serializeMachine } from "../serialization/serialize";
import { deserializeMachine } from "../serialization/deserialize";
import type { Executor, RunResult, RunOptions } from "../executor/types";
import type { Charter } from "../types/charter";
import type { Instance } from "../types/instance";
import { assistantMessage, userMessage } from "../types/messages";

function createNoopExecutor(): Executor<unknown> {
  return {
    type: "standard",
    run: async (
      _charter: Charter<unknown>,
      _instance: Instance,
      _ancestors: Instance[],
      _input: string,
      _options?: RunOptions<unknown>,
    ): Promise<RunResult<unknown>> => ({ yieldReason: "end_turn" }),
  };
}

function createStreamingMockExecutor(messageId: string): Executor<unknown> {
  return {
    type: "standard",
    run: async (
      _charter: Charter<unknown>,
      instance: Instance,
      _ancestors: Instance[],
      _input: string,
      options?: RunOptions<unknown>,
    ): Promise<RunResult<unknown>> => {
      const enqueue = options?.enqueue;
      if (!enqueue) throw new Error("Mock executor requires options.enqueue");

      const source = {
        instanceId: options?.instanceId ?? instance.id,
        isPrimary: !(options?.isWorker ?? false),
      };

      const vessel = assistantMessage("", {
        source,
        messageId,
        stream: { state: "streaming", seq: 0 },
      });
      const final = assistantMessage("final", {
        source,
        messageId,
        stream: { state: "complete", seq: 1 },
      });

      enqueue([vessel]);
      enqueue([final]);
      return { yieldReason: "end_turn" };
    },
  };
}

describe("streaming messageId replacement enqueue", () => {
  it("replaces queued messages by messageId and still calls onMessageEnqueue twice", () => {
    const node = createNode({
      instructions: "test",
      validator: z.object({}),
      initialState: {},
    });

    const onMessageEnqueue = vi.fn();
    const machine = createMachine(
      createCharter({ name: "test", executor: createNoopExecutor(), nodes: { node } }),
      { instance: createInstance(node, {}), onMessageEnqueue },
    );

    const messageId = "m-1";
    const vessel = assistantMessage("", { messageId, stream: { state: "streaming" } });
    const final = assistantMessage("done", { messageId, stream: { state: "complete" } });

    machine.enqueue([vessel]);
    expect(machine.queue).toHaveLength(1);
    expect(machine.queue[0]).toBe(vessel);

    machine.enqueue([final]);
    expect(machine.queue).toHaveLength(1);
    expect(machine.queue[0]).toBe(final);

    const assistantCalls = onMessageEnqueue.mock.calls
      .map(([m]) => m)
      .filter((m) => m.role === "assistant");
    expect(assistantCalls).toEqual([vessel, final]);
  });

  it("drains only the final message into MachineStep.history", async () => {
    const node = createNode({
      instructions: "test",
      validator: z.object({}),
      initialState: {},
    });

    const onMessageEnqueue = vi.fn();
    const messageId = "m-2";
    const charter = createCharter({
      name: "test",
      executor: createStreamingMockExecutor(messageId),
      nodes: { node },
    });

    const machine = createMachine(charter, { instance: createInstance(node, {}), onMessageEnqueue });

    machine.enqueue([userMessage("hi")]);
    const step = await runMachineToCompletion(machine, { streamWhenAvailable: true });

    const assistantHistory = step.history.filter((m) => m.role === "assistant");
    expect(assistantHistory).toHaveLength(1);
    expect(assistantHistory[0]?.items).toBe("final");
    expect(assistantHistory[0]?.metadata?.messageId).toBe(messageId);

    const assistantCalls = onMessageEnqueue.mock.calls
      .map(([m]) => m)
      .filter((m) => m.role === "assistant");
    expect(assistantCalls).toHaveLength(2);
    expect(assistantCalls[0]?.metadata?.stream?.state).toBe("streaming");
    expect(assistantCalls[1]?.metadata?.stream?.state).toBe("complete");
  });

  it("supports onMessageEnqueue and replacement after deserializeMachine", () => {
    const node = createNode({
      instructions: "test",
      validator: z.object({}),
      initialState: {},
    });

    const charter = createCharter({ name: "test", executor: createNoopExecutor(), nodes: { node } });
    const original = createMachine(charter, { instance: createInstance(node, {}) });
    const serialized = serializeMachine(original);

    const onMessageEnqueue = vi.fn();
    const machine = deserializeMachine(charter, serialized, { onMessageEnqueue });

    const messageId = "m-3";
    const vessel = assistantMessage("", { messageId, stream: { state: "streaming" } });
    const final = assistantMessage("done", { messageId, stream: { state: "complete" } });

    machine.enqueue([vessel]);
    machine.enqueue([final]);

    expect(machine.queue).toHaveLength(1);
    expect(machine.queue[0]).toBe(final);

    const assistantCalls = onMessageEnqueue.mock.calls
      .map(([m]) => m)
      .filter((m) => m.role === "assistant");
    expect(assistantCalls).toEqual([vessel, final]);
  });
});

