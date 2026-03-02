import { describe, it, expect } from "vitest";
import { createCharter } from "../core/charter";
import { createNode } from "../core/node";
import { createPack } from "../core/pack";
import { createInstance } from "../types/instance";
import { runToolPipeline } from "../runtime/tool-pipeline";
import { isInstanceMessage, type MachineMessage } from "../types/messages";
import type { Executor, RunResult, RunOptions } from "../executor/types";
import type { Charter } from "../types/charter";
import type { Instance } from "../types/instance";

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

describe("tool pipeline patch emission", () => {
  it("emits partial node-state patch from node tools", async () => {
    const node = createNode<{ count: number; untouched: string }>({
      instructions: "Node",
      validator: createSchema((input) => {
        const obj = parseObject(input);
        if (typeof obj.count !== "number") throw new Error("count must be number");
        if (typeof obj.untouched !== "string") throw new Error("untouched must be string");
        return { count: obj.count, untouched: obj.untouched };
      }),
      initialState: { count: 0, untouched: "keep" },
      tools: {
        increment: {
          name: "increment",
          description: "Increment count",
          inputSchema: createSchema(() => ({})),
          execute: (_input, ctx) => {
            ctx.updateState({ count: ctx.state.count + 1 });
            return "ok";
          },
        },
      },
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { node },
    });

    const instance = createInstance(node, { count: 0, untouched: "keep" });
    const emitted: MachineMessage[] = [];

    await runToolPipeline({
      charter,
      instance,
      ancestors: [],
      packStates: {},
      enqueue: (messages) => emitted.push(...messages),
    }, [{ id: "tool-1", name: "increment", input: {} }]);

    const stateMessage = emitted.find((msg) => {
      if (!isInstanceMessage(msg)) return false;
      return msg.items.kind === "state";
    });
    expect(stateMessage).toBeDefined();
    if (!stateMessage || !isInstanceMessage(stateMessage) || stateMessage.items.kind !== "state") {
      throw new Error("Expected state instance message");
    }
    expect(stateMessage.items.patch).toEqual({ count: 1 });
  });

  it("emits partial pack-state patch from pack tools", async () => {
    const settingsPack = createPack({
      name: "settings",
      description: "Settings",
      validator: createSchema((input) => {
        const obj = parseObject(input);
        if (typeof obj.voiceEnabled !== "boolean") throw new Error("voiceEnabled must be boolean");
        if (typeof obj.cameraEnabled !== "boolean") throw new Error("cameraEnabled must be boolean");
        return { voiceEnabled: obj.voiceEnabled, cameraEnabled: obj.cameraEnabled };
      }),
      initialState: { voiceEnabled: false, cameraEnabled: true },
      tools: {
        setVoiceEnabled: {
          name: "setVoiceEnabled",
          description: "Set voice mode",
          inputSchema: createSchema((input) => {
            const obj = parseObject(input);
            if (typeof obj.enabled !== "boolean") throw new Error("enabled must be boolean");
            return { enabled: obj.enabled };
          }),
          execute: (input, ctx) => {
            ctx.updateState({ voiceEnabled: input.enabled });
            return "ok";
          },
        },
      },
    });

    const node = createNode({
      instructions: "Node",
      validator: createSchema((input) => {
        const obj = parseObject(input);
        return obj;
      }),
      initialState: {},
      packs: [settingsPack],
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { node },
      packs: [settingsPack],
    });

    const instance = createInstance(node, {}, undefined, {
      settings: { voiceEnabled: false, cameraEnabled: true },
    });
    const emitted: MachineMessage[] = [];

    await runToolPipeline({
      charter,
      instance,
      ancestors: [],
      packStates: { settings: { voiceEnabled: false, cameraEnabled: true } },
      enqueue: (messages) => emitted.push(...messages),
    }, [{ id: "tool-2", name: "setVoiceEnabled", input: { enabled: true } }]);

    const packStateMessage = emitted.find((msg) => {
      if (!isInstanceMessage(msg)) return false;
      return msg.items.kind === "packState" && msg.items.packName === "settings";
    });
    expect(packStateMessage).toBeDefined();
    if (!packStateMessage || !isInstanceMessage(packStateMessage) || packStateMessage.items.kind !== "packState") {
      throw new Error("Expected packState instance message");
    }
    expect(packStateMessage.items.patch).toEqual({ voiceEnabled: true });
  });
});
