import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createCharter } from "../core/charter";
import { createNode } from "../core/node";
import { createInstance } from "../types/instance";
import { createMachine } from "../core/machine";
import { runMachineToCompletion } from "../core/run";
import type { Executor, RunOptions, RunResult } from "../executor/types";
import type { Charter } from "../types/charter";
import type { Instance } from "../types/instance";
import type { MachineMessage } from "../types/messages";
import {
  assistantMessage,
  ephemeralMessage,
  userMessage,
  isEphemeralMessage,
} from "../types/messages";

function createNoopNode() {
  return createNode({
    instructions: "test",
    validator: z.object({}),
    initialState: {},
  });
}

function createCapturingExecutor(
  onRun: (history: MachineMessage[], options?: RunOptions) => void,
  behavior?: (options?: RunOptions) => void | Promise<void>,
): Executor {
  return {
    type: "standard",
    run: async (
      _charter: Charter<any>,
      _instance: Instance,
      _ancestors: Instance[],
      _input: string,
      options?: RunOptions,
    ): Promise<RunResult> => {
      onRun((options?.history as MachineMessage[] | undefined) ?? [], options);
      if (behavior) {
        await behavior(options);
      }
      options?.enqueue?.([assistantMessage("ok")]);
      return { yieldReason: "end_turn" };
    },
  };
}

describe("ephemeral messages", () => {
  it("waitForQueue ignores ephemeral messages", async () => {
    const executor: Executor = {
      type: "standard",
      run: async (): Promise<RunResult> => ({ yieldReason: "end_turn" }),
    };

    const node = createNoopNode();
    const charter = createCharter({ name: "test", executor });
    const machine = createMachine(charter, {
      instance: createInstance(node, {}),
    });

    const waitPromise = machine.waitForQueue();

    machine.enqueue([ephemeralMessage("camera frame")]);

    const result = await Promise.race([
      waitPromise.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 25)),
    ]);
    expect(result).toBe("timeout");

    machine.enqueue([userMessage("hi")]);
    const result2 = await Promise.race([
      waitPromise.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 25)),
    ]);
    expect(result2).toBe("resolved");
  });

  it("collapses singleton ephemerals and injects as synthetic user messages (not persisted)", async () => {
    const histories: MachineMessage[][] = [];
    const executor = createCapturingExecutor((h) => histories.push(h));

    const node = createNoopNode();
    const charter = createCharter({ name: "test", executor });
    const machine = createMachine(charter, {
      instance: createInstance(node, {}),
    });

    machine.enqueue([
      ephemeralMessage(
        [{ type: "image", mimeType: "image/jpeg", data: "AAA", detail: "low" }],
        { singleton: "camera" },
      ),
      ephemeralMessage(
        [{ type: "image", mimeType: "image/jpeg", data: "BBB", detail: "low" }],
        { singleton: "camera" },
      ),
      userMessage("what do you see?"),
    ]);

    await runMachineToCompletion(machine);

    expect(histories.length).toBe(1);
    const historyForModel = histories[0]!;

    // Synthetic camera frame should appear before the real user message for this run.
    expect(historyForModel[0]?.role).toBe("user");
    expect(Array.isArray(historyForModel[0]?.items)).toBe(true);
    expect(historyForModel[1]?.role).toBe("user");
    expect(historyForModel[1]?.items).toBe("what do you see?");

    const syntheticItems = historyForModel[0]!.items as any[];
    expect(syntheticItems[0]?.type).toBe("text");
    expect(String(syntheticItems[0]?.text)).toContain("Frames since last turn: 2");
    expect(syntheticItems[1]?.type).toBe("image");
    expect(syntheticItems[1]?.data).toBe("BBB"); // last-write-wins

    // Collapsed ephemerals are persisted in machine.history.
    expect(machine.history.some(isEphemeralMessage)).toBe(true);
    const ephemeralInHistory = machine.history.filter(isEphemeralMessage);
    expect(ephemeralInHistory).toHaveLength(1); // collapsed from 2 to 1
    expect(ephemeralInHistory[0]?.metadata?.singletonFrameCount).toBe(2);
  });

  it("does not drain ephemerals during step drains (they remain queued for next run)", async () => {
    const histories: MachineMessage[][] = [];
    const executor = createCapturingExecutor(
      (h) => histories.push(h),
      async (options) => {
        // Enqueue an ephemeral frame mid-run.
        options?.enqueue?.([
          ephemeralMessage(
            [{ type: "image", mimeType: "image/jpeg", data: "MID", detail: "low" }],
            { singleton: "camera" },
          ),
        ]);
      },
    );

    const node = createNoopNode();
    const charter = createCharter({ name: "test", executor });
    const machine = createMachine(charter, {
      instance: createInstance(node, {}),
    });

    machine.enqueue([userMessage("first")]);
    await runMachineToCompletion(machine);

    expect(machine.queue.length).toBe(1);
    expect(isEphemeralMessage(machine.queue[0]!)).toBe(true);

    machine.enqueue([userMessage("second")]);
    await runMachineToCompletion(machine);

    // The mid-run ephemeral should be injected on the next run.
    expect(histories.length).toBe(2);
    const secondRunHistory = histories[1]!;
    expect(Array.isArray(secondRunHistory[2]?.items)).toBe(true);
    const injected = secondRunHistory[2]!.items as any[];
    expect(injected[0]?.type).toBe("text");
    expect(String(injected[0]?.text)).toContain("[Camera frame]");
    expect(injected[1]?.type).toBe("image");
    expect(injected[1]?.data).toBe("MID");
  });
});

