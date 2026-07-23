import { describe, expect, it } from "vitest";
import {
  createMachine,
  createNode,
  hydrateInstance,
  runMachine,
  serializeInstance,
  textUserMessage,
  type Frame,
  type FrameMessage,
} from "../../index.ts";
import { charter, createRecordingExecutor, drain } from "./helpers.ts";

// Floor negotiation: per broadcast actor frame, a matching `primary`
// activates unless a matching `primary` with `suppressAncestors` exists
// strictly below it on its own descendant path. Peers coexist; suppressors
// take lineage tenure; every other trigger type always runs.
describe("conformance: floor negotiation (primary trigger)", () => {
  it("suppressing primary child suppresses its ancestor primary — no activation, no inference", async () => {
    const { executor, requests } = createRecordingExecutor();
    const specialist = createNode({
      key: "specialist",
      runtime: { type: "generator", trigger: { type: "primary", suppressAncestors: true } },
    });
    const root = createNode({
      key: "root",
      members: [specialist],
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const machine = createMachine({
      id: "floor-suppress-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
      executor,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });

    const frames = await drain(runMachine(machine));

    expect(workActivationRuntimeIds(frames)).toEqual(["member:r/specialist"]);
    expect(requests.map((request) => request.generatorId)).toEqual(["member:r/specialist"]);
    await expect(drain(runMachine(machine, { scheduleWork: false }))).resolves.toEqual([]);
  });

  it("restores the suppressed primary after the suppressing child cedes", async () => {
    const { executor, requests } = createRecordingExecutor();
    const specialist = createNode({
      key: "specialist",
      runtime: { type: "generator", trigger: { type: "primary", suppressAncestors: true } },
    });
    const root = createNode({
      key: "root",
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const machine = createMachine({
      id: "floor-cede-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: charter({ nodes: [specialist] }),
      executor,
    });
    machine.enqueueFrame({
      messages: [
        {
          type: "instance",
          kind: "spawn",
          parentInstanceId: "r",
          children: [{ id: "child", node: "specialist" }],
        },
      ],
    });
    const tenureFrame = machine.enqueueFrame({ messages: [{ ...textUserMessage("during tenure") }] });
    const tenureDrain = await drain(runMachine(machine));
    expect(requests.map((request) => request.generatorId)).toEqual(["instance:child"]);
    // The suppression is recorded durably: a "suppressed" completion marks
    // the root's turn as decided (still no activation, no compile, no
    // inference).
    expect(workCompletions(tenureDrain)).toContainEqual(
      expect.objectContaining({
        generatorId: "instance:r",
        sourceFrameId: tenureFrame.id,
        reason: "suppressed",
      }),
    );

    machine.enqueueFrame({
      messages: [{ type: "instance", kind: "remove", instanceId: "child", reason: "cede" }],
    });
    const followingFrame = machine.enqueueFrame({ messages: [{ ...textUserMessage("after cede") }] });
    const frames = await drain(runMachine(machine));

    // After cede the root does NOT re-open the tenure frame the child already
    // answered — its suppressed completion holds — and takes the next
    // broadcast frame.
    expect(workActivations(frames)).toEqual([
      { generatorId: "instance:r", sourceFrameId: followingFrame.id },
    ]);
    expect(requests.map((request) => request.generatorId)).toEqual([
      "instance:child",
      "instance:r",
    ]);
    await expect(drain(runMachine(machine, { scheduleWork: false }))).resolves.toEqual([]);
  });

  it("lets plain actor-frame observers activate through active suppression", async () => {
    const observer = createNode({
      key: "observer",
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const specialist = createNode({
      key: "specialist",
      runtime: { type: "generator", trigger: { type: "primary", suppressAncestors: true } },
    });
    const root = createNode({
      key: "root",
      members: [observer, specialist],
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const machine = createMachine({
      id: "floor-observer-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });

    const frames = await drain(runMachine(machine, { scheduleWork: false }));
    expect(workActivationRuntimeIds(frames).sort()).toEqual([
      "member:r/observer",
      "member:r/specialist",
    ]);
  });

  it("lets a non-suppressing primary child activate alongside its parent primary", async () => {
    const peer = createNode({
      key: "peer",
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const root = createNode({
      key: "root",
      members: [peer],
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const machine = createMachine({
      id: "floor-peer-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });

    const frames = await drain(runMachine(machine, { scheduleWork: false }));
    expect(workActivationRuntimeIds(frames).sort()).toEqual(["instance:r", "member:r/peer"]);
  });

  it("lets two suppressing primary siblings both activate while their ancestor is suppressed", async () => {
    const first = createNode({
      key: "first",
      runtime: { type: "generator", trigger: { type: "primary", suppressAncestors: true } },
    });
    const second = createNode({
      key: "second",
      runtime: { type: "generator", trigger: { type: "primary", suppressAncestors: true } },
    });
    const root = createNode({
      key: "root",
      members: [first, second],
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const machine = createMachine({
      id: "floor-siblings-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });

    const frames = await drain(runMachine(machine, { scheduleWork: false }));
    expect(workActivationRuntimeIds(frames).sort()).toEqual([
      "member:r/first",
      "member:r/second",
    ]);
  });

  it("composes nested suppressors: only the deepest primary activates", async () => {
    const inner = createNode({
      key: "inner",
      runtime: { type: "generator", trigger: { type: "primary", suppressAncestors: true } },
    });
    const outer = createNode({
      key: "outer",
      members: [inner],
      runtime: { type: "generator", trigger: { type: "primary", suppressAncestors: true } },
    });
    const root = createNode({
      key: "root",
      members: [outer],
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const machine = createMachine({
      id: "floor-nested-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });

    const frames = await drain(runMachine(machine, { scheduleWork: false }));
    expect(workActivationRuntimeIds(frames)).toEqual(["member:r/outer/inner"]);
  });

  it("never arbitrates spawn, parent-activation, or parent-completion triggers", async () => {
    const { executor, requests } = createRecordingExecutor();
    const watcher = createNode({
      key: "watcher",
      runtime: { type: "generator", trigger: { type: "parent-activation" } },
    });
    const memory = createNode({
      key: "memory",
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const specialist = createNode({
      key: "specialist",
      members: [watcher, memory],
      runtime: { type: "generator", trigger: { type: "primary", suppressAncestors: true } },
    });
    const helper = createNode({
      key: "helper",
      runtime: { type: "generator", trigger: { type: "spawn" } },
    });
    const root = createNode({
      key: "root",
      members: [specialist],
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const machine = createMachine({
      id: "floor-unarbitrated-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: charter({ nodes: [helper] }),
      executor,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });
    machine.enqueueFrame({
      messages: [
        {
          type: "instance",
          kind: "spawn",
          parentInstanceId: "r",
          children: [{ id: "spawned", node: "helper" }],
        },
      ],
    });

    const frames = await drain(runMachine(machine));
    const runtimeIds = workActivationRuntimeIds(frames);
    expect(runtimeIds).not.toContain("instance:r");
    expect(runtimeIds).toContain("member:r/specialist");
    expect(runtimeIds).toContain("member:r/specialist/watcher");
    expect(runtimeIds).toContain("member:r/specialist/memory");
    expect(runtimeIds).toContain("instance:spawned");
    expect(requests.map((request) => request.generatorId)).not.toContain("instance:r");
  });

  it("honors audience-targeted actor frames for a primary that broadcast would suppress", async () => {
    const specialist = createNode({
      key: "specialist",
      runtime: { type: "generator", trigger: { type: "primary", suppressAncestors: true } },
    });
    const root = createNode({
      key: "root",
      members: [specialist],
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const machine = createMachine({
      id: "floor-targeted-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
    });
    machine.enqueueFrame({
      messages: [
        {
          ...textUserMessage("just for the root"),
          audience: { type: "instance", instanceId: "r" },
        },
      ],
    });

    // The targeted frame is invisible to the specialist, so the contended set
    // is one and the arbiter no-ops: explicit addressing is the escape hatch.
    const frames = await drain(runMachine(machine, { scheduleWork: false }));
    expect(workActivationRuntimeIds(frames)).toEqual(["instance:r"]);
  });

  it("arbitrates identically after mid-tenure reassembly", async () => {
    const specialist = createNode({
      key: "specialist",
      runtime: { type: "generator", trigger: { type: "primary", suppressAncestors: true } },
    });
    const root = createNode({
      key: "root",
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const sessionCharter = charter({ nodes: [specialist, root] });
    const source = createMachine({
      id: "floor-replay-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: sessionCharter,
      executor: createRecordingExecutor().executor,
    });
    source.enqueueFrame({
      messages: [
        {
          type: "instance",
          kind: "spawn",
          parentInstanceId: "r",
          children: [{ id: "child", node: "specialist" }],
        },
      ],
    });
    source.enqueueFrame({ messages: [{ ...textUserMessage("during tenure") }] });
    await drain(runMachine(source));

    // Crash during suppression tenure: reassemble from the serialized
    // instance tree and the frame log alone.
    const rehydrated = createMachine({
      id: "floor-replay-demo",
      instance: hydrateInstance(serializeInstance(source.instance, sessionCharter), sessionCharter),
      charter: sessionCharter,
      frames: source.frames.map((frame) => ({ ...frame, messages: [...frame.messages] })),
    });
    await expect(drain(runMachine(rehydrated, { scheduleWork: false }))).resolves.toEqual([]);

    // The child still holds the floor for the next broadcast frame.
    rehydrated.enqueueFrame({ messages: [{ ...textUserMessage("after reassembly") }] });
    const frames = await drain(runMachine(rehydrated, { scheduleWork: false }));
    expect(workActivationRuntimeIds(frames)).toEqual(["instance:child"]);
  });

  it("gives a [spawn, primary] child same-drain takeover without disturbing the parent's in-flight turn", async () => {
    let spawnFrame: Frame | undefined;
    const { executor, requests } = createRecordingExecutor((request) => {
      if (request.generatorId === "instance:r") {
        spawnFrame = machine.enqueueFrame({
          messages: [
            {
              type: "instance",
              kind: "spawn",
              parentInstanceId: "r",
              children: [{ id: "helper", node: "specialist" }],
            },
          ],
        });
      }
      return { completionReason: "done" };
    });
    const specialist = createNode({
      key: "specialist",
      runtime: {
        type: "generator",
        trigger: [{ type: "spawn" }, { type: "primary", suppressAncestors: true }],
      },
    });
    const root = createNode({
      key: "root",
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const machine = createMachine({
      id: "floor-takeover-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: charter({ nodes: [specialist] }),
      executor,
    });
    const turnFrame = machine.enqueueFrame({ messages: [{ ...textUserMessage("hand me off") }] });
    const firstDrain = await drain(runMachine(machine));

    // The parent's in-flight activation completes normally (the floor
    // governs new admissions, never in-flight work) …
    expect(workCompletions(firstDrain)).toContainEqual(
      expect.objectContaining({
        generatorId: "instance:r",
        sourceFrameId: turnFrame.id,
        reason: "end-turn",
      }),
    );
    // … and the child activates on its spawn frame in the same drain. The
    // spawn-sourced activation is uncontended (spawn is never arbitrated);
    // the child's primary trigger does not negotiate for the turn frame that
    // predates its spawn, so the takeover is a single generation.
    expect(
      workActivations(firstDrain).filter((message) => message.generatorId === "instance:helper"),
    ).toEqual([{ generatorId: "instance:helper", sourceFrameId: spawnFrame?.id }]);
    expect(requests.map((request) => request.generatorId)).toEqual([
      "instance:r",
      "instance:helper",
    ]);

    // From the next broadcast actor frame onward the primary trigger
    // arbitrates: the child takes it, the parent does not.
    const nextFrame = machine.enqueueFrame({ messages: [{ ...textUserMessage("next turn") }] });
    const secondDrain = await drain(runMachine(machine));
    expect(workActivations(secondDrain)).toMatchObject([
      { generatorId: "instance:helper", sourceFrameId: nextFrame.id },
    ]);
    expect(requests.map((request) => request.generatorId)).toEqual([
      "instance:r",
      "instance:helper",
      "instance:helper",
    ]);
  });

  it("does not treat suppressed completions as parent completions", async () => {
    const { executor, requests } = createRecordingExecutor();
    const memory = createNode({
      key: "memory",
      runtime: {
        type: "generator",
        trigger: { type: "parent-completion" },
        outputAudienceDefault: "self",
      },
    });
    const specialist = createNode({
      key: "specialist",
      runtime: { type: "generator", trigger: { type: "primary", suppressAncestors: true } },
    });
    const root = createNode({
      key: "root",
      members: [memory, specialist],
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const machine = createMachine({
      id: "floor-suppressed-completion-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
      executor,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });
    const tenureDrain = await drain(runMachine(machine));

    // The root's suppressed no-op completion is not a completion to react
    // to: the memory generator stays quiet through suppression tenure.
    expect(workCompletions(tenureDrain)).toContainEqual(
      expect.objectContaining({ generatorId: "instance:r", reason: "suppressed" }),
    );
    expect(workActivationRuntimeIds(tenureDrain)).toEqual(["member:r/specialist"]);

    // A real end-turn completion of the root (reached via targeted
    // addressing) is.
    machine.enqueueFrame({
      messages: [
        {
          ...textUserMessage("just for the root"),
          audience: { type: "instance", instanceId: "r" },
        },
      ],
    });
    const targetedDrain = await drain(runMachine(machine));
    expect(workActivationRuntimeIds(targetedDrain)).toEqual([
      "instance:r",
      "member:r/memory",
    ]);
    expect(requests.map((request) => request.generatorId)).toEqual([
      "member:r/specialist",
      "instance:r",
      "member:r/memory",
    ]);
  });

  it("does not let a primary spawned mid-turn answer the turn that spawned it", async () => {
    // The announce-then-handoff pattern: the parent finishes the current turn
    // by announcing the handoff; the specialist (primary only — no spawn
    // trigger declared) takes the NEXT turn and must not double-respond.
    const { executor, requests } = createRecordingExecutor((request) => {
      if (request.generatorId === "instance:r") {
        machine.enqueueFrame({
          messages: [
            {
              type: "instance",
              kind: "spawn",
              parentInstanceId: "r",
              children: [{ id: "helper", node: "specialist" }],
            },
          ],
        });
      }
      return { completionReason: "done" };
    });
    const specialist = createNode({
      key: "specialist",
      runtime: { type: "generator", trigger: { type: "primary", suppressAncestors: true } },
    });
    const root = createNode({
      key: "root",
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const machine = createMachine({
      id: "floor-announce-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: charter({ nodes: [specialist] }),
      executor,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hand me off") }] });
    const firstDrain = await drain(runMachine(machine));

    expect(workActivationRuntimeIds(firstDrain)).toEqual(["instance:r"]);
    expect(requests.map((request) => request.generatorId)).toEqual(["instance:r"]);

    machine.enqueueFrame({ messages: [{ ...textUserMessage("next turn") }] });
    await drain(runMachine(machine));
    expect(requests.map((request) => request.generatorId)).toEqual([
      "instance:r",
      "instance:helper",
    ]);
  });

  it("rejects duplicate trigger types in one runtime", () => {
    expect(() =>
      createNode({
        key: "doubled",
        runtime: {
          type: "generator",
          trigger: [{ type: "primary" }, { type: "primary", suppressAncestors: true }],
        },
      }),
    ).toThrow('Duplicate trigger type "primary" declared on one runtime');
  });
});

function workActivations(frames: readonly Frame[]): Array<{
  generatorId: string;
  sourceFrameId: string;
}> {
  return frames.flatMap((frame) =>
    frame.messages.flatMap((message) => {
      const record = message as Record<string, unknown>;
      return record.type === "work" &&
        record.kind === "activation" &&
        typeof record.generatorId === "string" &&
        typeof record.sourceFrameId === "string"
        ? [{ generatorId: record.generatorId, sourceFrameId: record.sourceFrameId }]
        : [];
    }),
  );
}

function workActivationRuntimeIds(frames: readonly Frame[]): string[] {
  return workActivations(frames).map((activation) => activation.generatorId);
}

function workCompletions(frames: readonly Frame[]): FrameMessage[] {
  return frames.flatMap((frame) =>
    frame.messages.filter(
      (message) => message.type === "work" && message.kind === "completion",
    ),
  );
}
