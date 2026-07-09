import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createMachine,
  createNode,
  createRoot,
  createAction,
  createUnboundActionContext,
  runMachine,
  textUserMessage,
  type Instance,
} from "../../index.ts";
import { charter, createRecordingExecutor, drain, requestForRuntime } from "./helpers.ts";

describe("conformance: state access", () => {
  it("keeps local retrieval state inside the mounted runtime that owns it", async () => {
    const { executor, requests } = createRecordingExecutor();
    const child = createNode({
      key: "child",
      states: [{
        key: "localSecret",
        scope: "local",
        schema: z.object({ owner: z.string() }),
        init: { owner: "child" },
        projection: { exposure: "deferred" },
      }],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const root = createNode({
      key: "root",
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "local-state-demo",
      instance: { id: "root", isSource: true, node: root, children: [{ id: "child", isSource: true, node: child }] },
      charter: charter(),
      executor,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("run") }] });

    await drain(runMachine(machine));

    const parentRequest = requestForRuntime(requests, "instance:root");
    expect(parentRequest.inference.retrievableStates).toEqual([]);
    expect(parentRequest.inference.tools.map((tool) => tool.name)).toEqual([]);

    const childRequest = requestForRuntime(requests, "instance:child");
    expect(childRequest.inference.retrievableStates).toEqual([
      { address: "localSecret", target: { instanceId: "child", stateKey: "localSecret" } },
    ]);
    const getState = childRequest.inference.tools.find((tool) => tool.name === "getState");
    expect(getState).toBeDefined();
    expect(getState?.run?.(
      { address: "localSecret" },
      childRequest.createActionContext?.(getState) ?? createUnboundActionContext(),
    )).toEqual({ owner: "child" });
  });

  it("resolves hoist state to the real root instance for tools below that root", async () => {
    const { executor, requests } = createRecordingExecutor();
    const state = {
      key: "session",
      scope: "hoist" as const,
      schema: z.object({ owner: z.string() }),
      init: { owner: "root" },
    };
    const readA = createAction({ state, name: "readA" });
    const readB = createAction({ state, name: "readB" });
    const memberA = createNode({ key: "memberA", states: [state], tools: [readA] });
    const memberB = createNode({ key: "memberB", states: [state], tools: [readB] });
    const root = createNode({
      key: "root",
      members: [memberA, memberB],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const rootInstance: Instance = { id: "root", isSource: true, node: root };
    const machine = createMachine({
      id: "hoist-state-demo",
      instance: rootInstance,
      charter: charter(),
      executor,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("run") }] });

    await drain(runMachine(machine));

    const request = requestForRuntime(requests, "instance:root");
    expect(request.inference.tools.map((tool) => tool.name)).toEqual(["readA", "readB"]);
    const boundReadA = request.inference.tools.find((tool) => tool.name === "readA");
    const boundReadB = request.inference.tools.find((tool) => tool.name === "readB");
    expect(request.createActionContext?.(boundReadA!)?.state).toEqual({ owner: "root" });
    expect(request.createActionContext?.(boundReadB!)?.state).toEqual({ owner: "root" });
    // Both members read the shared init through the hoist address, but reads
    // never realize: the container only attaches on a logged write.
    expect(rootInstance.states?.session).toBeUndefined();
  });

  it("keeps hoist state isolated between direct root machines", async () => {
    const first = createRecordingExecutor();
    const second = createRecordingExecutor();
    const node = createNode({
      key: "root",
      states: [{
        key: "session",
        scope: "hoist",
        schema: z.object({ owner: z.string() }),
        projection: { exposure: "deferred" },
      }],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machineA = createMachine({
      id: "root-a-demo",
      instance: { id: "a", isSource: true, node, states: { session: { value: { owner: "a" } } } },
      charter: charter(),
      executor: first.executor,
    });
    const machineB = createMachine({
      id: "root-b-demo",
      instance: { id: "b", isSource: true, node, states: { session: { value: { owner: "b" } } } },
      charter: charter(),
      executor: second.executor,
    });
    machineA.enqueueFrame({ messages: [{ ...textUserMessage("run") }] });
    machineB.enqueueFrame({ messages: [{ ...textUserMessage("run") }] });

    await drain(runMachine(machineA));
    await drain(runMachine(machineB));

    const a = requestForRuntime(first.requests, "instance:a");
    const b = requestForRuntime(second.requests, "instance:b");
    expect(a.inference.retrievableStates).toEqual([
      { address: "session", target: { instanceId: "a", stateKey: "session" } },
    ]);
    expect(b.inference.retrievableStates).toEqual([
      { address: "session", target: { instanceId: "b", stateKey: "session" } },
    ]);
    const getStateA = a.inference.tools.find((tool) => tool.name === "getState");
    const getStateB = b.inference.tools.find((tool) => tool.name === "getState");
    expect(getStateA?.run?.(
      { address: "session" },
      a.createActionContext?.(getStateA) ?? createUnboundActionContext(),
    )).toEqual({ owner: "a" });
    expect(getStateB?.run?.(
      { address: "session" },
      b.createActionContext?.(getStateB) ?? createUnboundActionContext(),
    )).toEqual({ owner: "b" });
    expect(() =>
      getStateA?.run?.(
        { address: "session:b" },
        a.createActionContext?.(getStateA) ?? createUnboundActionContext(),
      ),
    ).toThrow(/Unknown retrievable state address/);
    expect(() =>
      getStateB?.run?.(
        { address: "session:a" },
        b.createActionContext?.(getStateB) ?? createUnboundActionContext(),
      ),
    ).toThrow(/Unknown retrievable state address/);
  });
});
