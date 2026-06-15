import { describe, expect, it } from "vitest";
import {
  compileProjection,
  createActivationFrame,
  createMachine,
  createNode,
  runMachine,
  type Frame,
} from "../../index.ts";
import { charter, createRecordingExecutor, drain, requestForRuntime } from "./helpers.ts";

describe("conformance: projection IR", () => {
  it("projects component descendants upward and exports runtime aggregates through boundaryProjection", async () => {
    const { executor, requests } = createRecordingExecutor();
    const memory = createNode({ key: "memory", instructions: "memory" });
    const worker = createNode({
      key: "summarizer",
      instructions: "worker",
      members: [memory],
      runtime: {
        type: "worker",
        trigger: { type: "parent-completion" },
        boundaryProjection: { mode: "augment", instructions: "dynamic" },
      },
    });
    const policy = createNode({ key: "policy", instructions: "policy" });
    const root = createNode({
      key: "root",
      instructions: "root",
      members: [policy, worker],
      runtime: { type: "primary", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "projection-demo",
      root: { id: "r", node: root },
      charter: charter({ executor }),
    });
    machine.enqueueFrame({ messages: [{ type: "user", text: "summarize" }] });

    await drain(runMachine(machine));

    const parent = requestForRuntime(requests, "instance:r");
    expect(parent.inference.systemParts).toEqual(["root", "policy"]);
    expect(parent.inference.dynamicParts).toEqual(["worker", "memory"]);
    expect(parent.inference.history).toEqual([{ type: "user", text: "summarize" }]);
  });

  it("hides child runtime aggregates from parent inference by default", async () => {
    const { executor, requests } = createRecordingExecutor();
    const hiddenTool = { state: null, name: "hiddenTool" };
    const hiddenState = createNode({
      key: "hiddenState",
      instructions: "hidden-state",
      tools: [hiddenTool],
    });
    const worker = createNode({
      key: "hiddenWorker",
      instructions: "worker",
      members: [hiddenState],
      runtime: { type: "worker", trigger: { type: "parent-completion" } },
    });
    const root = createNode({
      key: "root",
      instructions: "root",
      members: [worker],
      runtime: { type: "primary", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "hidden-boundary-demo",
      root: { id: "r", node: root },
      charter: charter({ executor }),
    });
    machine.enqueueFrame({ messages: [{ type: "user", text: "run" }] });

    await drain(runMachine(machine));

    const parent = requestForRuntime(requests, "instance:r");
    expect(parent.inference.systemParts).toEqual(["root"]);
    expect(parent.inference.dynamicParts).toEqual([]);
    expect(parent.inference.tools.map((tool) => tool.name)).toEqual([]);
    expect(parent.inference.retrievableStates).toEqual([]);
  });

  it("compiles a child runtime from its own boundary without ancestor leakage", async () => {
    const { executor, requests } = createRecordingExecutor();
    const memory = createNode({ key: "memory", instructions: "memory" });
    const worker = createNode({
      key: "worker",
      instructions: "worker",
      members: [memory],
      runtime: { type: "worker", trigger: { type: "parent-completion" } },
    });
    const policy = createNode({ key: "policy", instructions: "policy" });
    const root = createNode({
      key: "root",
      instructions: "root",
      members: [policy, worker],
      runtime: { type: "primary", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "child-runtime-demo",
      root: { id: "r", node: root },
      charter: charter({ executor }),
    });
    machine.enqueueFrame({ messages: [{ type: "user", text: "run" }] });

    await drain(runMachine(machine));

    const child = requestForRuntime(requests, "member:r/worker");
    expect(child.inference.systemParts).toEqual(["worker", "memory"]);
    expect(child.inference.dynamicParts).toEqual([]);
    expect(child.inference.systemParts).not.toContain("root");
    expect(child.inference.systemParts).not.toContain("policy");
  });

  it("filters actor history by default, self, and explicit audiences", () => {
    const worker = createNode({
      key: "worker",
      runtime: { type: "worker", trigger: { type: "parent-completion" } },
    });
    const root = createNode({ key: "root", members: [worker] });
    const runtimeInstanceId = "member:r/worker";
    const workerAddress = {
      type: "member" as const,
      ownerInstanceId: "r",
      memberPath: ["worker"],
    };

    const compiled = compileProjection(
      { id: "r", node: root },
      {
        targetGenerator: generator(runtimeInstanceId, "worker"),
        frameHistory: [
          frame("user", [{ type: "user", text: "default broadcast" }]),
          frame("other-self", [{ type: "assistant", text: "hidden self" }]),
          frame(
            "worker-self",
            [{ type: "assistant", text: "visible self" }],
            { generatorId: runtimeInstanceId },
          ),
          frame("runtime-target", [
            {
              type: "tool",
              name: "trace",
              audience: workerAddress,
            },
          ]),
          frame("address-list-target", [
            {
              type: "assistant",
              text: "visible address list target",
              audience: [workerAddress],
            },
          ]),
          frame("other-runtime", [
            {
              type: "assistant",
              text: "hidden runtime target",
              audience: { type: "instance", instanceId: "r" },
            },
          ]),
        ],
      },
    );

    expect(compiled.history).toEqual([
      { type: "user", text: "default broadcast" },
      { type: "assistant", text: "visible self" },
      {
        type: "tool",
        name: "trace",
        audience: workerAddress,
      },
      {
        type: "assistant",
        text: "visible address list target",
        audience: [workerAddress],
      },
    ]);
  });

  it("applies queued delivery and live activation history", () => {
    const root = createNode({
      key: "root",
      runtime: {
        type: "primary",
        trigger: { type: "actor-frame" },
        activationHistory: "live",
      },
    });
    const activationId = "activation-live";

    const compiled = compileProjection(
      { id: "r", node: root },
      {
        targetGenerator: generator("instance:r", "primary"),
        activationId,
        frameHistory: [
          frame("before", [{ type: "user", text: "queued before", delivery: "queued" }]),
          activationFrame(activationId, "instance:r", "before"),
          frame("after", [{ type: "user", text: "immediate after" }]),
          frame("queued-after", [{ type: "user", text: "queued after", delivery: "queued" }]),
        ],
      },
    );

    expect(compiled.history).toEqual([
      { type: "user", text: "queued before", delivery: "queued" },
      { type: "user", text: "immediate after" },
    ]);
  });

  it("applies snapshot activation history while keeping same-activation output", () => {
    const root = createNode({
      key: "root",
      runtime: {
        type: "primary",
        trigger: { type: "actor-frame" },
        activationHistory: "snapshot",
      },
    });
    const activationId = "activation-snapshot";

    const compiled = compileProjection(
      { id: "r", node: root },
      {
        targetGenerator: generator("instance:r", "primary"),
        activationId,
        frameHistory: [
          frame("before", [{ type: "user", text: "before" }]),
          activationFrame(activationId, "instance:r", "before"),
          frame("after", [{ type: "user", text: "hidden external after" }]),
          frame(
            "same-activation",
            [{ type: "assistant", text: "same activation" }],
            {
              generatorId: "instance:r",
              runtimeInstanceId: "instance:r",
              activationId,
            },
          ),
        ],
      },
    );

    expect(compiled.history).toEqual([
      { type: "user", text: "before" },
      { type: "assistant", text: "same activation" },
    ]);
  });

  it("requires durable activation work when compiling activation history", () => {
    const root = createNode({
      key: "root",
      runtime: { type: "primary", trigger: { type: "actor-frame" } },
    });

    expect(() =>
      compileProjection(
        { id: "r", node: root },
        {
          targetGenerator: generator("instance:r", "primary"),
          activationId: "activation-missing",
        },
      ),
    ).toThrow(/requires frameHistory/);

    expect(() =>
      compileProjection(
        { id: "r", node: root },
        {
          targetGenerator: generator("instance:r", "primary"),
          activationId: "activation-missing",
          frameHistory: [frame("user", [{ type: "user", text: "hi" }])],
        },
      ),
    ).toThrow(/activation work frame/);
  });
});

function generator(runtimeInstanceId: string, kind: "primary" | "worker") {
  return { id: runtimeInstanceId, kind, runtimeInstanceId };
}

function frame(
  id: string,
  messages: Frame["messages"],
  overrides: Partial<Omit<Frame, "id" | "messages">> = {},
): Frame {
  return { id, messages, ...overrides };
}

function activationFrame(
  activationId: string,
  runtimeInstanceId: string,
  sourceFrameId: string,
): Frame {
  return {
    id: `work-${activationId}`,
    ...createActivationFrame({
      activationId,
      runtimeInstanceId,
      generatorId: runtimeInstanceId,
      sourceFrameId,
      concurrencyKey: runtimeInstanceId,
      concurrency: "serial",
    }),
  };
}
