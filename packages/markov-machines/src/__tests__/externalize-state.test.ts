import { describe, it, expect } from "vitest";
import { createCharter } from "../core/charter";
import { createNode } from "../core/node";
import { createPack } from "../core/pack";
import { createMachine } from "../core/machine";
import { runCommand } from "../core/commands";
import { applyInstanceMessages, runMachineToCompletion } from "../core/run";
import { createInstance } from "../types/instance";
import { instanceMessage, isInstanceMessage, userMessage } from "../types/messages";
import { commandResult } from "../types/commands";
import type { Charter } from "../types/charter";
import type { Instance } from "../types/instance";
import type { Executor, RunOptions, RunResult } from "../executor/types";

function createSchema<T>(parse: (input: unknown) => T) {
  return {
    safeParse: (input: unknown): { success: true; data: T } | { success: false; error: { message: string } } => {
      try {
        return { success: true, data: parse(input) };
      } catch (error) {
        return {
          success: false,
          error: { message: error instanceof Error ? error.message : String(error) },
        };
      }
    },
  } as any;
}

function parseObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null) {
    throw new Error("Expected object");
  }
  return input as Record<string, unknown>;
}

function createMockExecutor(): Executor {
  return {
    type: "standard",
    run: async (
      _charter: Charter,
      _instance: Instance,
      _ancestors: Instance[],
      _input: string,
      _options?: RunOptions,
    ): Promise<RunResult> => {
      return { yieldReason: "end_turn" };
    },
  };
}

describe("externalized state ownership", () => {
  it("routes node state updates through externalize handler and requires setState", () => {
    const seenPatches: Record<string, unknown>[] = [];
    const node = createNode({
      instructions: "Externalized node",
      validator: createSchema((input) => {
        const obj = parseObject(input);
        if (typeof obj.count !== "number") throw new Error("count must be number");
        return { count: obj.count };
      }),
      initialState: { count: 0 },
      externalize: {
        state: ({ onInstanceMessage, setState }) => {
          onInstanceMessage((_state, event) => {
            seenPatches.push(event.patch);
            setState(event.patch);
          });
        },
      },
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { node },
    });
    const machine = createMachine(charter, {
      instance: createInstance(node, { count: 0 }),
    });

    applyInstanceMessages(
      machine,
      [instanceMessage({ kind: "state", instanceId: machine.instance.id, patch: { count: 7 } })],
      1,
    );

    expect(seenPatches).toEqual([{ count: 7 }]);
    const state = machine.instance.state as { count: number };
    expect(state.count).toBe(7);
  });

  it("does not apply externalized pack state unless handler sets state", () => {
    const seenPatches: Record<string, unknown>[] = [];
    const settingsPack = createPack({
      name: "settings",
      description: "Settings",
      validator: createSchema((input) => {
        const obj = parseObject(input);
        if (typeof obj.voiceEnabled !== "boolean") throw new Error("voiceEnabled must be boolean");
        return { voiceEnabled: obj.voiceEnabled };
      }),
      initialState: { voiceEnabled: false },
      externalize: {
        state: ({ onMutation }) => {
          onMutation((_state, event) => {
            seenPatches.push(event.patch);
          });
        },
      },
    });

    const node = createNode({
      instructions: "Node",
      validator: createSchema((input) => parseObject(input)),
      initialState: {},
      packs: [settingsPack],
    });

    const machine = createMachine(
      createCharter({
        name: "test",
        executor: createMockExecutor(),
        nodes: { node },
        packs: [settingsPack],
      }),
      {
        instance: createInstance(node, {}, undefined, {
          settings: { voiceEnabled: false },
        }),
      },
    );

    applyInstanceMessages(
      machine,
      [instanceMessage({ kind: "packState", packName: "settings", patch: { voiceEnabled: true } })],
      1,
    );

    expect(seenPatches).toEqual([{ voiceEnabled: true }]);
    const packState = machine.instance.packStates?.settings as { voiceEnabled: boolean };
    expect(packState.voiceEnabled).toBe(false);
  });

  it("does not immediately overwrite externalized node state in runCommand", async () => {
    const node = createNode({
      instructions: "Externalized node command",
      validator: createSchema((input) => {
        const obj = parseObject(input);
        if (typeof obj.count !== "number") throw new Error("count must be number");
        return { count: obj.count };
      }),
      initialState: { count: 0 },
      externalize: {
        state: ({ onMutation, setState }) => {
          onMutation((_state, event) => {
            setState(event.patch);
          });
        },
      },
      commands: {
        increment: {
          name: "increment",
          description: "Increment count",
          inputSchema: createSchema(() => ({})),
          execute: (_input, ctx) => {
            ctx.updateState({ count: 1 });
            return commandResult({ ok: true });
          },
        },
      },
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { node },
    });
    const machine = createMachine(charter, {
      instance: createInstance(node, { count: 0 }),
    });

    const { machine: updated, result } = await runCommand(machine, "increment", {});
    expect(result.success).toBe(true);
    const stateAfterCommand = updated.instance.state as { count: number };
    expect(stateAfterCommand.count).toBe(0);

    // Once instance messages are applied, handler-owned setState applies the patch.
    const instanceMessages = updated.queue.filter(isInstanceMessage);
    applyInstanceMessages(updated, instanceMessages, 1);
    const stateAfterApply = updated.instance.state as { count: number };
    expect(stateAfterApply.count).toBe(1);
  });

  it("passes initial-drain mutations into first onStep callback", async () => {
    const stepEvents: Array<{ patches: Record<string, unknown>[]; stepNumbers: number[] }> = [];
    const node = createNode({
      instructions: "Externalized node step callback",
      validator: createSchema((input) => {
        const obj = parseObject(input);
        if (typeof obj.count !== "number") throw new Error("count must be number");
        return { count: obj.count };
      }),
      initialState: { count: 0 },
      externalize: {
        state: ({ onMutation, onStep, setState }) => {
          onMutation((_state, event) => {
            setState(event.patch);
          });
          onStep((_step, events) => {
            stepEvents.push({
              patches: events.map((event) => event.patch),
              stepNumbers: events.map((event) => event.stepNumber),
            });
          });
        },
      },
    });

    const machine = createMachine(
      createCharter({
        name: "test",
        executor: createMockExecutor(),
        nodes: { node },
      }),
      {
        instance: createInstance(node, { count: 0 }),
      },
    );

    machine.enqueue([
      userMessage("hello"),
      instanceMessage({ kind: "state", instanceId: machine.instance.id, patch: { count: 4 } }),
    ]);

    await runMachineToCompletion(machine);

    const state = machine.instance.state as { count: number };
    expect(state.count).toBe(4);
    expect(stepEvents.length).toBeGreaterThan(0);
    expect(stepEvents[0]?.patches).toEqual([{ count: 4 }]);
    expect(stepEvents[0]?.stepNumbers).toEqual([0]);
  });
});
