import { describe, expect, it } from "vitest";
import {
  compileProjection,
  createHistoryProjectionFunction,
  createLayout,
  createMachine,
  createNode,
  createRuntimeTurnFrame,
  createSlot,
  messagesSinceLastCompletion,
  runMachine,
  syncMachineRuntime,
  textUserMessage,
  type Frame,
  type ProjectorExecutor,
  type RuntimeSyncContext,
} from "../../index.ts";
import { charter, createRecordingExecutor, drain } from "./helpers.ts";
import { z } from "zod";

function actorFrameNode(key = "root") {
  return createNode({
    key,
    runtime: { type: "generator", trigger: { type: "actor-frame" } },
  });
}

describe("conformance: executor binding", () => {
  it("folds frames and executes without an executor, but throws when work is scheduled", async () => {
    const machine = createMachine({
      id: "no-executor",
      instance: { id: "r", isSource: true, node: actorFrameNode() },
      charter: charter(),
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hello") }] });

    // Folding and read-only draining work without a generator runtime.
    const frames = await drain(runMachine(machine, { scheduleWork: false }));
    expect(frames.length).toBeGreaterThan(0);
    expect(
      compileProjection(machine.instance, {
        charter: machine.charter,
        targetGeneratorId: "instance:r",
        frameHistory: machine.frames,
      }).history.length,
    ).toBeGreaterThan(0);

    await expect(drain(runMachine(machine))).rejects.toThrow(/no executor/);
  });

  it("keeps sync-context frames ungenerated so external user frames still trigger activations", async () => {
    // Regression: the LiveKit executors relay external user messages through
    // RuntimeSyncContext.enqueueFrame. If that path stamped the sync target's
    // generatorId onto the frame, the self-trigger exclusion would suppress
    // the generator's own activation and the message would get no response.
    const { executor, requests } = createRecordingExecutor();
    const syncable: ProjectorExecutor & {
      syncRuntime(context: RuntimeSyncContext): void;
    } = {
      ...executor,
      identity: { name: "test-executor" },
      syncRuntime(context) {
        context.enqueueFrame(
          { messages: [{ ...textUserMessage("from transport") }] },
          { transport: "test" },
        );
      },
    };
    const machine = createMachine({
      id: "sync-demo",
      instance: { id: "r", isSource: true, node: actorFrameNode() },
      charter: charter(),
      executor: syncable,
    });

    await syncMachineRuntime(machine, { generatorId: "instance:r" });
    const userFrame = machine.frames.find((frame) =>
      frame.messages.some((message) => message.type === "user"),
    );
    expect(userFrame?.generatorId).toBeUndefined();
    expect(userFrame?.provenance).toMatchObject({
      producer: { executor: { name: "test-executor" } },
      execution: { transport: "test" },
    });

    await drain(runMachine(machine));
    expect(requests.map((request) => request.generatorId)).toEqual(["instance:r"]);
  });

  it("delivers the node's executorConfig namespace per activation and validates it at bind time", async () => {
    const { executor, requests } = createRecordingExecutor();
    const configured: ProjectorExecutor = {
      ...executor,
      identity: { name: "test-executor" },
      configSchema: z.object({ model: z.string() }),
    };
    const node = createNode({
      key: "root",
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
      executorConfig: {
        "test-executor": { model: "gpt-5.5" },
        "other-executor": { anything: true },
      },
    });

    expect(() =>
      createMachine({
        instance: { id: "bad", isSource: true, node },
        charter: charter(),
        executor: {
          ...configured,
          configSchema: z.object({ model: z.number() }),
        },
      }),
    ).toThrow(/Invalid executorConfig\["test-executor"\] on node "root"/);

    const machine = createMachine({
      id: "config-demo",
      instance: { id: "r", isSource: true, node },
      charter: charter(),
      executor: configured,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });
    await drain(runMachine(machine));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.config).toEqual({ model: "gpt-5.5" });
  });
});

describe("conformance: provenance", () => {
  it("signs executor-produced and machine-synthesized frames, and reports execution facts", async () => {
    const { executor } = createRecordingExecutor((request) => {
      request.enqueueFrame(
        { messages: [] },
        { latencyMs: 12, usage: { outputTokens: 3 } },
      );
      return { completionReason: "done", value: "hi there", execution: { latencyMs: 40 } };
    });
    const identified: ProjectorExecutor = {
      ...executor,
      identity: { name: "test-executor", version: "0.1" },
    };
    const machine = createMachine({
      id: "signing-demo",
      instance: { id: "r", isSource: true, node: actorFrameNode() },
      charter: charter(),
      executor: identified,
      runner: { workerId: "worker-7" },
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hello") }] });
    const frames = await drain(runMachine(machine));

    const activationFrame = frames.find((frame) =>
      frame.messages.some((message) => message.type === "work" && message.kind === "activation"),
    );
    expect(activationFrame?.provenance).toMatchObject({
      producer: { machine: "scheduler" },
      runner: { workerId: "worker-7" },
    });

    const executorFrame = frames.find((frame) => frame.provenance?.execution?.latencyMs === 12);
    expect(executorFrame?.provenance).toMatchObject({
      producer: { executor: { name: "test-executor", version: "0.1" } },
      execution: { latencyMs: 12, usage: { outputTokens: 3 } },
      runner: { workerId: "worker-7" },
    });

    const valueFrame = frames.find((frame) =>
      frame.messages.some((message) => message.type === "assistant"),
    );
    expect(valueFrame?.provenance).toMatchObject({
      producer: { executor: { name: "test-executor", version: "0.1" } },
      execution: { latencyMs: 40 },
    });

    const completionFrame = frames.find((frame) =>
      frame.messages.some((message) => message.type === "work" && message.kind === "completion"),
    );
    expect(completionFrame?.provenance).toMatchObject({
      producer: { executor: { name: "test-executor" } },
      execution: { latencyMs: 40 },
    });
  });

  it("keeps the fold identical with provenance stripped and hides it from history projections", async () => {
    const seenHistories: Frame[][] = [];
    const recordingProjection = createHistoryProjectionFunction({
      name: "recording",
      method: (ctx) => {
        seenHistories.push(ctx.history);
        return messagesSinceLastCompletion(ctx);
      },
    });
    const node = createNode({
      key: "root",
      runtime: {
        type: "generator",
        trigger: { type: "actor-frame" },
      },
    });
    const recordingLayout = createLayout({
      name: "recordingLayout",
      historyProjection: recordingProjection,
      regions: {
        preamble: [createSlot("body", { default: true })],
        recency: [createSlot("context", { default: true, volatile: true })],
      },
    });
    const { executor } = createRecordingExecutor(() => ({
      completionReason: "done",
      value: "answer",
    }));
    const identified: ProjectorExecutor = { ...executor, identity: { name: "test-executor" } };
    const machine = createMachine({
      id: "strip-demo",
      instance: { id: "r", isSource: true, node },
      charter: charter({ historyProjections: [recordingProjection], layouts: [recordingLayout] }),
      executor: identified,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("first") }] });
    await drain(runMachine(machine));
    machine.enqueueFrame({ messages: [{ ...textUserMessage("second") }] });
    await drain(runMachine(machine));

    // History-projection code never observes provenance.
    expect(seenHistories.length).toBeGreaterThan(0);
    for (const history of seenHistories) {
      for (const frame of history) {
        expect(frame.provenance).toBeUndefined();
      }
    }
    expect(machine.frames.some((frame) => frame.provenance !== undefined)).toBe(true);

    // fold(charter, frames) === fold(charter, stripProvenance(frames)).
    const compileFor = (frames: Frame[]) =>
      compileProjection(machine.instance, {
        charter: machine.charter,
        targetGeneratorId: "instance:r",
        frameHistory: frames,
      });
    const stripped = machine.frames.map(({ provenance: _omitted, ...frame }) => frame);
    expect(compileFor(stripped as Frame[])).toEqual(compileFor(machine.frames));
  });

  it("treats runtime turn frames as completion boundaries via messages alone", () => {
    const history: Frame[] = [
      { id: "before", messages: [{ ...textUserMessage("old") }] },
      {
        id: "turn",
        ...createRuntimeTurnFrame({
          generatorId: "instance:r",
          activationId: "activation:realtime:turn-1",
          sourceFrameId: "before",
        }),
      },
      { id: "after", messages: [{ ...textUserMessage("new") }] },
    ];

    const since = messagesSinceLastCompletion({
      generatorId: "instance:r",
      activationId: "activation-2",
      trigger: { type: "actor-frame" },
      history,
      states: {},
    });
    expect(since).toEqual([{ ...textUserMessage("new") }]);
  });
});
