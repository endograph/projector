import { describe, expect, it } from "vitest";
import { createMachine, createNode, runMachine, type Frame, type FrameMessage } from "../../index.ts";
import { charter, createRecordingExecutor, drain } from "./helpers.ts";

describe("conformance: work scheduling", () => {
  it("creates durable activation and completion frames in host-gated order", async () => {
    const { executor, requests } = createRecordingExecutor();
    const worker = createNode({
      key: "memory",
      runtime: { type: "worker", trigger: { type: "parent-completion" } },
    });
    const root = createNode({
      key: "root",
      members: [worker],
      runtime: { type: "primary", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "work-demo",
      root: { id: "r", node: root },
      charter: charter({ executor }),
    });
    const userFrame = machine.enqueueFrame({
      messages: [{ type: "user", text: "remember my name" }],
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
      runtimeInstanceId: "instance:r",
      generatorId: "instance:r",
      sourceFrameId: userFrame.id,
      concurrencyKey: "instance:r",
      concurrency: "serial",
    });
    expect(requests).toHaveLength(0);

    const rootCompletion = await iterator.next();
    expect(requests.map((request) => request.runtimeInstanceId)).toEqual(["instance:r"]);
    expect(rootCompletion.value?.messages[0]).toMatchObject({
      type: "work",
      kind: "completion",
      activationId: (rootActivationMessage as { activationId: string }).activationId,
      sourceFrameId: userFrame.id,
      reason: "end-turn",
    });

    const workerActivation = await iterator.next();
    const workerActivationMessage = workerActivation.value?.messages[0];
    expect(workerActivationMessage).toMatchObject({
      type: "work",
      kind: "activation",
      runtimeInstanceId: "member:r/memory",
      generatorId: "member:r/memory",
      sourceFrameId: rootCompletion.value?.id,
      concurrencyKey: "member:r/memory",
      concurrency: "serial",
    });

    const workerCompletion = await iterator.next();
    expect(requests.map((request) => request.runtimeInstanceId)).toEqual([
      "instance:r",
      "member:r/memory",
    ]);
    expect(workerCompletion.value?.messages[0]).toMatchObject({
      type: "work",
      kind: "completion",
      activationId: (workerActivationMessage as { activationId: string }).activationId,
      sourceFrameId: rootCompletion.value?.id,
      reason: "done",
    });

    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await expect(drain(runMachine(machine, { startWork: false }))).resolves.toEqual([]);
  });

  it("does not let actor output from a runtime trigger that same runtime again", async () => {
    const root = createNode({
      key: "root",
      runtime: { type: "primary", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "self-trigger-demo",
      root: { id: "r", node: root },
      charter: charter(),
    });
    const assistantFrame = machine.enqueueFrame({
      generatorId: "instance:r",
      runtimeInstanceId: "instance:r",
      activationId: "activation-existing",
      messages: [{ type: "assistant", text: "self output" }],
    });

    await expect(drain(runMachine(machine, { startWork: false }))).resolves.toEqual([assistantFrame]);
  });

  it("matches actor-frame triggers with default and explicit runtime address audiences", async () => {
    await expect(activationRuntimeIdsFor({ type: "user", text: "broadcast" })).resolves.toEqual([
      "member:r/first",
      "member:r/second",
    ]);

    await expect(
      activationRuntimeIdsFor({
        type: "assistant",
        text: "runtime target",
        audience: { type: "member", ownerInstanceId: "r", memberPath: ["first"] },
      }),
    ).resolves.toEqual(["member:r/first"]);

    await expect(
      activationRuntimeIdsFor({
        type: "assistant",
        text: "runtime target list",
        audience: [{ type: "member", ownerInstanceId: "r", memberPath: ["second"] }],
      }),
    ).resolves.toEqual(["member:r/second"]);

    await expect(
      activationRuntimeIdsFor({ type: "assistant", text: "default self without producer" }),
    ).resolves.toEqual([]);
  });

  it("does not activate runtimes whose trigger does not match the audience-visible frame", async () => {
    const worker = createNode({
      key: "worker",
      runtime: { type: "worker", trigger: { type: "parent-completion" } },
    });
    const root = createNode({ key: "root", members: [worker] });
    const machine = createMachine({
      id: "trigger-demo",
      root: { id: "r", node: root },
      charter: charter(),
    });
    machine.enqueueFrame({ messages: [{ type: "user", text: "visible but wrong trigger" }] });

    const frames = await drain(runMachine(machine, { startWork: false }));
    expect(workActivationRuntimeIds(frames)).toEqual([]);
  });
});

async function activationRuntimeIdsFor(message: FrameMessage): Promise<string[]> {
  const first = createNode({
    key: "first",
    runtime: { type: "primary", trigger: { type: "actor-frame" } },
  });
  const second = createNode({
    key: "second",
    runtime: { type: "primary", trigger: { type: "actor-frame" } },
  });
  const root = createNode({
    key: "root",
    members: [first, second],
  });
  const machine = createMachine({
    id: "audience-demo",
    root: { id: "r", node: root },
    charter: charter(),
  });
  machine.enqueueFrame({ messages: [message] });

  return workActivationRuntimeIds(await drain(runMachine(machine, { startWork: false })));
}

function workActivationRuntimeIds(frames: readonly Frame[]): string[] {
  return frames.flatMap((frame) =>
    frame.messages.flatMap((message) => {
      const record = message as Record<string, unknown>;
      return record.type === "work" &&
        record.kind === "activation" &&
        typeof record.runtimeInstanceId === "string"
        ? [record.runtimeInstanceId]
        : [];
    }),
  );
}
