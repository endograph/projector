import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMachine, createNode, createRoot, createTool, runMachine, type Instance } from "../../index.ts";
import { charter, createRecordingExecutor, drain, requestForRuntime } from "./helpers.ts";

describe("conformance: state access", () => {
  it("keeps local retrieval state inside the mounted runtime that owns it", async () => {
    const { executor, requests } = createRecordingExecutor();
    const child = createNode({
      key: "child",
      state: {
        key: "localSecret",
        scope: "local",
        schema: z.object({ owner: z.string() }),
        init: { owner: "child" },
        projection: "retrieval",
      },
      runtime: { type: "primary", trigger: { type: "actor-frame" } },
    });
    const root = createNode({
      key: "root",
      runtime: { type: "primary", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "local-state-demo",
      root: { id: "root", node: root, children: [{ id: "child", node: child }] },
      charter: charter({ executor }),
    });
    machine.enqueueFrame({ messages: [{ type: "user", text: "run" }] });

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
      childRequest.createActionContext?.(getState) ?? {},
    )).toEqual({ owner: "child" });
  });

  it("resolves top state to the real root instance for tools below that root", async () => {
    const { executor, requests } = createRecordingExecutor();
    const readA = createTool({ state: null, name: "readA" });
    const readB = createTool({ state: null, name: "readB" });
    const state = {
      key: "session",
      scope: "top" as const,
      schema: z.object({ owner: z.string() }),
      init: { owner: "root" },
    };
    const memberA = createNode({ key: "memberA", state, tools: [readA] });
    const memberB = createNode({ key: "memberB", state, tools: [readB] });
    const root = createNode({
      key: "root",
      members: [memberA, memberB],
      runtime: { type: "primary", trigger: { type: "actor-frame" } },
    });
    const rootInstance: Instance = { id: "root", node: root };
    const machine = createMachine({
      id: "top-state-demo",
      root: rootInstance,
      charter: charter({ executor }),
    });
    machine.enqueueFrame({ messages: [{ type: "user", text: "run" }] });

    await drain(runMachine(machine));

    const request = requestForRuntime(requests, "instance:root");
    expect(request.inference.tools.map((tool) => tool.name)).toEqual(["readA", "readB"]);
    const boundReadA = request.inference.tools.find((tool) => tool.name === "readA");
    const boundReadB = request.inference.tools.find((tool) => tool.name === "readB");
    expect(request.createActionContext?.(boundReadA!)?.state).toEqual({ owner: "root" });
    expect(request.createActionContext?.(boundReadB!)?.state).toEqual({ owner: "root" });
    expect(rootInstance.states?.session?.value).toEqual({ owner: "root" });
  });

  it("does not share top state between separate root instances", async () => {
    const { executor, requests } = createRecordingExecutor();
    const node = createNode({
      key: "root",
      state: {
        key: "session",
        scope: "top",
        schema: z.object({ owner: z.string() }),
        projection: "retrieval",
      },
      runtime: { type: "primary", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "separate-roots-demo",
      root: createRoot([
        { id: "a", node, states: { session: { value: { owner: "a" } } } },
        { id: "b", node, states: { session: { value: { owner: "b" } } } },
      ]),
      charter: charter({ executor }),
    });
    machine.enqueueFrame({ messages: [{ type: "user", text: "run" }] });

    await drain(runMachine(machine));

    const a = requestForRuntime(requests, "instance:a");
    const b = requestForRuntime(requests, "instance:b");
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
      a.createActionContext?.(getStateA) ?? {},
    )).toEqual({ owner: "a" });
    expect(getStateB?.run?.(
      { address: "session" },
      b.createActionContext?.(getStateB) ?? {},
    )).toEqual({ owner: "b" });
    expect(() =>
      getStateA?.run?.({ address: "session:b" }, a.createActionContext?.(getStateA) ?? {}),
    ).toThrow(/Unknown retrievable state address/);
    expect(() =>
      getStateB?.run?.({ address: "session:a" }, b.createActionContext?.(getStateB) ?? {}),
    ).toThrow(/Unknown retrievable state address/);
  });
});
