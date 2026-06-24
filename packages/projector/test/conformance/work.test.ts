import { describe, expect, it } from "vitest";
import {
  createActivationFrame,
  createCompletionFrame,
  createMachine,
  createNode,
  runMachine,
  textAssistantMessage,
  textUserMessage,
  type Frame,
  type FrameMessage,
} from "../../index.ts";
import { charter, createRecordingExecutor, drain } from "./helpers.ts";

describe("conformance: work scheduling", () => {
  it("creates durable activation and completion frames in host-gated order", async () => {
    const { executor, requests } = createRecordingExecutor();
    const generator = createNode({
      key: "memory",
      runtime: {
        type: "generator",
        trigger: { type: "parent-completion" },
        outputAudienceDefault: "self",
      },
    });
    const root = createNode({
      key: "root",
      members: [generator],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "work-demo",
      root: { id: "r", isSource: true, node: root },
      charter: charter({ executor }),
    });
    const userFrame = machine.enqueueFrame({
      messages: [{ ...textUserMessage("remember my name") }],
    });

    const iterator = runMachine(machine)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: userFrame.id },
    });
    expect(requests).toHaveLength(0);

    const rootActivation = await iterator.next();
    const rootActivationMessage = rootActivation.value?.messages[0];
    expect(rootActivationMessage).toMatchObject({
      type: "work",
      kind: "activation",
      generatorId: "instance:r",
      sourceFrameId: userFrame.id,
      concurrencyKey: "instance:r",
      concurrency: "serial",
    });
    expect(requests).toHaveLength(0);

    const rootCompletion = await iterator.next();
    expect(requests.map((request) => request.generatorId)).toEqual(["instance:r"]);
    expect(rootCompletion.value?.messages[0]).toMatchObject({
      type: "work",
      kind: "completion",
      activationId: (rootActivationMessage as { activationId: string }).activationId,
      sourceFrameId: userFrame.id,
      reason: "end-turn",
    });

    const generatorActivation = await iterator.next();
    const generatorActivationMessage = generatorActivation.value?.messages[0];
    expect(generatorActivationMessage).toMatchObject({
      type: "work",
      kind: "activation",
      generatorId: "member:r/memory",
      sourceFrameId: rootCompletion.value?.id,
      concurrencyKey: "member:r/memory",
      concurrency: "serial",
    });

    const generatorCompletion = await iterator.next();
    expect(requests.map((request) => request.generatorId)).toEqual([
      "instance:r",
      "member:r/memory",
    ]);
    expect(generatorCompletion.value?.messages[0]).toMatchObject({
      type: "work",
      kind: "completion",
      activationId: (generatorActivationMessage as { activationId: string }).activationId,
      sourceFrameId: rootCompletion.value?.id,
      reason: "done",
    });

    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await expect(drain(runMachine(machine, { scheduleWork: false }))).resolves.toEqual([]);
  });

  it("does not let actor output from a runtime trigger that same runtime again", async () => {
    const root = createNode({
      key: "root",
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "self-trigger-demo",
      root: { id: "r", isSource: true, node: root },
      charter: charter(),
    });
    const assistantFrame = machine.enqueueFrame({
      generatorId: "instance:r",
      activationId: "activation-existing",
      messages: [{ ...textAssistantMessage("self output") }],
    });

    await expect(drain(runMachine(machine, { scheduleWork: false }))).resolves.toEqual([assistantFrame]);
  });

  it("marks implicit generator output as self-audience assistant messages", async () => {
    const { executor, requests } = createRecordingExecutor((request) => ({
      completionReason: "done",
      ...(request.generatorId === "member:r/memory" ? { value: "memory updated" } : {}),
    }));
    const generator = createNode({
      key: "memory",
      runtime: {
        type: "generator",
        trigger: { type: "parent-completion" },
        outputAudienceDefault: "self",
      },
    });
    const root = createNode({
      key: "root",
      members: [generator],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "generator-output-demo",
      root: { id: "r", isSource: true, node: root },
      charter: charter({ executor }),
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("remember my name") }] });

    const frames = await drain(runMachine(machine));
    const generatorRequest = requests.find((request) => request.generatorId === "member:r/memory");
    const assistantMessages = frames.flatMap((frame) =>
      frame.messages.filter((message) => message.type === "assistant"),
    );

    expect(generatorRequest?.output?.audience).toBe("self");
    expect(assistantMessages).toEqual([
      {
        type: "assistant",
        content: [{ type: "text", text: "memory updated" }],
        text: "memory updated",
        audience: "self",
      },
    ]);
  });

  it("matches actor-frame triggers with default and explicit projection address audiences", async () => {
    await expect(activationRuntimeIdsFor({ ...textUserMessage("broadcast") })).resolves.toEqual([
      "member:r/first",
      "member:r/second",
    ]);

    await expect(
      activationRuntimeIdsFor({
        ...textAssistantMessage("runtime target"),
        audience: { type: "member", ownerInstanceId: "r", memberPath: ["first"] },
      }),
    ).resolves.toEqual(["member:r/first"]);

    await expect(
      activationRuntimeIdsFor({
        ...textAssistantMessage("runtime target list"),
        audience: [{ type: "member", ownerInstanceId: "r", memberPath: ["second"] }],
      }),
    ).resolves.toEqual(["member:r/second"]);

    await expect(
      activationRuntimeIdsFor({ ...textAssistantMessage("default self without producer") }),
    ).resolves.toEqual([]);
  });

  it("does not activate runtimes whose trigger does not match the audience-visible frame", async () => {
    const generator = createNode({
      key: "generator",
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const root = createNode({ key: "root", members: [generator] });
    const machine = createMachine({
      id: "trigger-demo",
      root: { id: "r", isSource: true, node: root },
      charter: charter(),
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("visible but wrong trigger") }] });

    const frames = await drain(runMachine(machine, { scheduleWork: false }));
    expect(workActivationRuntimeIds(frames)).toEqual([]);
  });

  it("recovers parent-completion activations from the latest work frame inclusively", async () => {
    const memory = createNode({
      key: "memory",
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const root = createNode({
      key: "root",
      members: [memory],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const rootCompletion = {
      id: "root-completion-frame",
      ...createCompletionFrame({
        activationId: "root-activation",
        sourceFrameId: "user-frame",
        reason: "end-turn",
      }),
    } as Frame;
    const machine = createMachine({
      id: "inclusive-cursor-demo",
      root: { id: "r", isSource: true, node: root },
      charter: charter(),
      frames: [
        { id: "user-frame", messages: [{ ...textUserMessage("hi") }] },
        {
          id: "root-activation-frame",
          ...createActivationFrame({
            activationId: "root-activation",
            generatorId: "instance:r",
            sourceFrameId: "user-frame",
            concurrencyKey: "instance:r",
            concurrency: "serial",
          }),
        },
        rootCompletion,
      ],
    });

    const frames = await drain(runMachine(machine, { scheduleWork: false }));
    expect(workActivationRuntimeIds(frames)).toEqual(["member:r/memory"]);
    expect(frames[0]?.messages[0]).toMatchObject({
      type: "work",
      kind: "activation",
      sourceFrameId: rootCompletion.id,
    });
  });

  it("does not reschedule historical activations when frame history is forked into a new machine", async () => {
    const { executor } = createRecordingExecutor();
    const root = createNode({
      key: "root",
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const source = createMachine({
      id: "source-session",
      root: { id: "r", isSource: true, node: root },
      charter: charter({ executor }),
    });
    source.enqueueFrame({
      id: "user-1",
      messages: [{ ...textUserMessage("hi") }],
    } as Frame);

    await drain(runMachine(source));
    const fork = createMachine({
      id: "forked-session",
      root: { id: "r", isSource: true, node: root },
      charter: charter({ executor }),
      frames: source.frames.map((frame) => ({ ...frame, messages: [...frame.messages] })),
    });

    await expect(drain(runMachine(fork, { scheduleWork: false }))).resolves.toEqual([]);
  });
});

async function activationRuntimeIdsFor(message: FrameMessage): Promise<string[]> {
  const first = createNode({
    key: "first",
    runtime: { type: "generator", trigger: { type: "actor-frame" } },
  });
  const second = createNode({
    key: "second",
    runtime: { type: "generator", trigger: { type: "actor-frame" } },
  });
  const root = createNode({
    key: "root",
    members: [first, second],
  });
  const machine = createMachine({
    id: "audience-demo",
    root: { id: "r", isSource: true, node: root },
    charter: charter(),
  });
  machine.enqueueFrame({ messages: [message] });

  return workActivationRuntimeIds(await drain(runMachine(machine, { scheduleWork: false })));
}

function workActivationRuntimeIds(frames: readonly Frame[]): string[] {
  return frames.flatMap((frame) =>
    frame.messages.flatMap((message) => {
      const record = message as Record<string, unknown>;
      return record.type === "work" &&
        record.kind === "activation" &&
        typeof record.generatorId === "string"
        ? [record.generatorId]
        : [];
    }),
  );
}
