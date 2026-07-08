import { describe, expect, it } from "vitest";
import {
  compileProjection,
  createActivationFrame,
  createMachine,
  createNode,
  runMachine,
  textAssistantMessage,
  textUserMessage,
  type Frame,
} from "../../index.ts";
import { charter, createRecordingExecutor, drain, requestForRuntime } from "./helpers.ts";

// Implicit-layout preamble parts: merged into the default "body" slot, stable.
function textParts(...texts: string[]) {
  return texts.length <= 1
    ? texts.map((text) => ({ type: "text" as const, text, slot: "body", volatile: false }))
    : [{ type: "text" as const, text: texts.join("\n\n"), slot: "body", volatile: false }];
}

describe("conformance: projection IR", () => {
  it("projects component descendants upward and forwards augment boundaries as-is", async () => {
    const { executor, requests } = createRecordingExecutor();
    const memory = createNode({ key: "memory", instructions: "memory" });
    const generator = createNode({
      key: "summarizer",
      instructions: "generator",
      members: [memory],
      runtime: {
        type: "generator",
        trigger: { type: "parent-completion" },
        boundaryProjection: "augment",
      },
    });
    const policy = createNode({ key: "policy", instructions: "policy" });
    const root = createNode({
      key: "root",
      instructions: "root",
      members: [policy, generator],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "projection-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
      executor,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("summarize") }] });

    await drain(runMachine(machine));

    const parent = requestForRuntime(requests, "instance:r");
    expect(parent.inference.preamble).toEqual(textParts("root", "policy", "generator", "memory"));
    expect(parent.inference.recency).toEqual([]);
    expect(parent.inference.history).toMatchObject([
      { ...textUserMessage("summarize") },
      {
        type: "work",
        kind: "activation",
        generatorId: "instance:r",
        sourceFrameId: "frame-0",
      },
    ]);
  });

  it("hides child runtime aggregates from parent inference by default", async () => {
    const { executor, requests } = createRecordingExecutor();
    const hiddenTool = { state: null, name: "hiddenTool" };
    const hiddenState = createNode({
      key: "hiddenState",
      instructions: "hidden-state",
      tools: [hiddenTool],
    });
    const generator = createNode({
      key: "hiddenWorker",
      instructions: "generator",
      members: [hiddenState],
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const root = createNode({
      key: "root",
      instructions: "root",
      members: [generator],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "hidden-boundary-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
      executor,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("run") }] });

    await drain(runMachine(machine));

    const parent = requestForRuntime(requests, "instance:r");
    expect(parent.inference.preamble).toEqual(textParts("root"));
    expect(parent.inference.recency).toEqual([]);
    expect(parent.inference.tools.map((tool) => tool.name)).toEqual([]);
    expect(parent.inference.retrievableStates).toEqual([]);
  });

  it("compiles a child runtime from its own boundary without ancestor leakage", async () => {
    const { executor, requests } = createRecordingExecutor();
    const memory = createNode({ key: "memory", instructions: "memory" });
    const generator = createNode({
      key: "generator",
      instructions: "generator",
      members: [memory],
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const policy = createNode({ key: "policy", instructions: "policy" });
    const root = createNode({
      key: "root",
      instructions: "root",
      members: [policy, generator],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "child-runtime-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
      executor,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("run") }] });

    await drain(runMachine(machine));

    const child = requestForRuntime(requests, "member:r/generator");
    expect(child.inference.preamble).toEqual(textParts("generator", "memory"));
    expect(child.inference.recency).toEqual([]);
    const childTexts = child.inference.preamble.map((part) => (part.type === "text" ? part.text : ""));
    expect(childTexts.join("\n")).not.toContain("root");
    expect(childTexts.join("\n")).not.toContain("policy");
  });

  it("filters frame history by default, self, and explicit audiences", () => {
    const generator = createNode({
      key: "generator",
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const root = createNode({ key: "root", members: [generator] });
    const generatorId = "member:r/generator";
    const projectionAddress = {
      type: "member" as const,
      ownerInstanceId: "r",
      memberPath: ["generator"],
    };

    const compiled = compileProjection(
      { id: "r", isSource: true, node: root },
      {
        targetGeneratorId: generatorId,
        frameHistory: [
          frame("user", [{ ...textUserMessage("default broadcast") }]),
          frame("other-self", [{ ...textAssistantMessage("hidden self") }]),
          frame(
            "generator-self",
            [{ ...textAssistantMessage("visible self") }],
            { generatorId: generatorId },
          ),
          frame("runtime-target", [
            {
              type: "action",
              kind: "result",
              action: "tool",
              name: "trace",
              callId: "trace-1",
              success: true,
            },
          ]),
          frame("address-list-target", [
            {
              ...textAssistantMessage("visible address list target"),
              audience: [projectionAddress],
            },
          ]),
          frame("other-runtime", [
            {
              ...textAssistantMessage("hidden runtime target"),
              audience: { type: "instance", instanceId: "r" },
            },
          ]),
        ],
      },
    );

    expect(compiled.history).toEqual([
      { ...textUserMessage("default broadcast") },
      { ...textAssistantMessage("visible self") },
      {
        type: "action",
        kind: "result",
        action: "tool",
        name: "trace",
        callId: "trace-1",
        success: true,
      },
      {
        ...textAssistantMessage("visible address list target"),
        audience: [projectionAddress],
      },
    ]);
  });

  it("applies queued delivery and live activation history", () => {
    const root = createNode({
      key: "root",
      runtime: {
        type: "generator",
        trigger: { type: "actor-frame" },
        activationHistory: "live",
      },
    });
    const activationId = "activation-live";

    const compiled = compileProjection(
      { id: "r", isSource: true, node: root },
      {
        targetGeneratorId: "instance:r",
        activationId,
        frameHistory: [
          frame("before", [{ ...textUserMessage("queued before"), delivery: "queued" }]),
          activationFrame(activationId, "instance:r", "before"),
          frame("after", [{ ...textUserMessage("immediate after") }]),
          frame("queued-after", [{ ...textUserMessage("queued after"), delivery: "queued" }]),
        ],
      },
    );

    expect(compiled.history).toEqual([
      { ...textUserMessage("queued before"), delivery: "queued" },
      {
        type: "work",
        kind: "activation",
        activationId,
        generatorId: "instance:r",
        sourceFrameId: "before",
        concurrencyKey: "instance:r",
        concurrency: "serial",
      },
      { ...textUserMessage("immediate after") },
    ]);
  });

  it("applies snapshot activation history while keeping same-activation output", () => {
    const root = createNode({
      key: "root",
      runtime: {
        type: "generator",
        trigger: { type: "actor-frame" },
        activationHistory: "snapshot",
      },
    });
    const activationId = "activation-snapshot";

    const compiled = compileProjection(
      { id: "r", isSource: true, node: root },
      {
        targetGeneratorId: "instance:r",
        activationId,
        frameHistory: [
          frame("before", [{ ...textUserMessage("before") }]),
          activationFrame(activationId, "instance:r", "before"),
          frame("after", [{ ...textUserMessage("hidden external after") }]),
          frame(
            "same-activation",
            [{ ...textAssistantMessage("same activation") }],
            {
              generatorId: "instance:r",
              activationId,
            },
          ),
        ],
      },
    );

    expect(compiled.history).toEqual([
      { ...textUserMessage("before") },
      {
        type: "work",
        kind: "activation",
        activationId,
        generatorId: "instance:r",
        sourceFrameId: "before",
        concurrencyKey: "instance:r",
        concurrency: "serial",
      },
      { ...textAssistantMessage("same activation") },
    ]);
  });

  it("requires durable activation work when compiling activation history", () => {
    const root = createNode({
      key: "root",
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });

    expect(() =>
      compileProjection(
        { id: "r", isSource: true, node: root },
        {
          targetGeneratorId: "instance:r",
          activationId: "activation-missing",
        },
      ),
    ).toThrow(/requires frameHistory/);

    expect(() =>
      compileProjection(
        { id: "r", isSource: true, node: root },
        {
          targetGeneratorId: "instance:r",
          activationId: "activation-missing",
          frameHistory: [frame("user", [{ ...textUserMessage("hi") }])],
        },
      ),
    ).toThrow(/activation work frame/);
  });
});

function frame(
  id: string,
  messages: Frame["messages"],
  overrides: Partial<Omit<Frame, "id" | "messages">> = {},
): Frame {
  return { id, messages, ...overrides };
}

function activationFrame(
  activationId: string,
  generatorId: string,
  sourceFrameId: string,
): Frame {
  return {
    id: `work-${activationId}`,
    ...createActivationFrame({
      activationId,
      generatorId,
      sourceFrameId,
      concurrencyKey: generatorId,
      concurrency: "serial",
    }),
  };
}
