import { describe, it, expect } from "vitest";
import { createCharter } from "../core/charter";
import { createNode } from "../core/node";
import { createPack } from "../core/pack";
import { createInstance } from "../types/instance";
import { createMachine } from "../core/machine";
import { runCommand } from "../core/commands";
import { isInstanceMessage } from "../types/messages";
import type { Executor, RunOptions, RunResult } from "../executor/types";
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

describe("pack command patch emission", () => {
  it("emits one merged partial patch for multiple updateState calls", async () => {
    const settingsPack = createPack({
      name: "settings",
      description: "Settings pack",
      validator: createSchema((input) => {
        const obj = parseObject(input);
        if (typeof obj.voiceEnabled !== "boolean") throw new Error("voiceEnabled must be boolean");
        if (typeof obj.cameraEnabled !== "boolean") throw new Error("cameraEnabled must be boolean");
        return { voiceEnabled: obj.voiceEnabled, cameraEnabled: obj.cameraEnabled };
      }),
      initialState: { voiceEnabled: false, cameraEnabled: true },
      commands: {
        updateSettings: {
          name: "updateSettings",
          description: "Update settings",
          inputSchema: createSchema(() => ({})),
          execute: (_input, ctx) => {
            ctx.updateState({ voiceEnabled: true });
            ctx.updateState({ cameraEnabled: false });
          },
        },
      },
    });

    const node = createNode({
      instructions: "Node",
      validator: createSchema((input) => parseObject(input)),
      initialState: {},
      packs: [settingsPack],
    });

    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { node },
      packs: [settingsPack],
    });

    const machine = createMachine(charter, {
      instance: createInstance(node, {}, undefined, {
        settings: { voiceEnabled: false, cameraEnabled: true },
      }),
    });

    const { result } = await runCommand(machine, "updateSettings", {});
    expect(result.success).toBe(true);

    const packStateMessages = machine.queue.filter((msg) => {
      if (!isInstanceMessage(msg)) return false;
      return msg.items.kind === "packState" && msg.items.packName === "settings";
    });
    expect(packStateMessages).toHaveLength(1);
    const packStateMessage = packStateMessages[0]!;
    if (!isInstanceMessage(packStateMessage) || packStateMessage.items.kind !== "packState") {
      throw new Error("Expected packState instance message");
    }
    expect(packStateMessage.items.patch).toEqual({
      voiceEnabled: true,
      cameraEnabled: false,
    });
  });
});
