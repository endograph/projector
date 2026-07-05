import { describe, expect, it } from "vitest";
import { createMachine, createNode, createAction, runMachine, textUserMessage } from "../../index.ts";
import { charter, createRecordingExecutor, drain, requestForRuntime, toolByNameLastWins } from "./helpers.ts";

describe("conformance: projected tools", () => {
  it("preserves duplicate tool order so provider assembly can use last definition wins", async () => {
    const { executor, requests } = createRecordingExecutor();
    const baseSearch = createAction({ state: null, name: "search", description: "base" });
    const overrideSearch = createAction({ state: null, name: "search", description: "override" });
    const override = createNode({ key: "override", tools: [overrideSearch] });
    const root = createNode({
      key: "root",
      tools: [baseSearch],
      members: [override],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "tools-demo",
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
      executor,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("search") }] });

    await drain(runMachine(machine));

    const request = requestForRuntime(requests, "instance:r");
    expect(request.inference.tools.map((tool) => tool.description)).toEqual(["base", "override"]);
    expect(toolByNameLastWins(request).get("search")).toBe(request.inference.tools[1]);
  });

  it("resolves string tool refs through self, source node, then charter", async () => {
    const { executor, requests } = createRecordingExecutor();
    const charterSearch = createAction({ state: null, name: "search", description: "charter" });
    const sourceSearch = createAction({ state: null, name: "search", description: "source" });
    const selfSearch = createAction({ state: null, name: "search", description: "self" });
    const source = createNode({ key: "source", tools: [sourceSearch] });
    const self = createNode({ key: "self", sourceNodeKey: "source", tools: [selfSearch] });
    const sourced = createNode({ key: "sourced", sourceNodeKey: "source", tools: ["search"] });
    const global = createNode({ key: "global", tools: ["search"] });
    const root = createNode({
      key: "root",
      members: [self, sourced, global],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      instance: { id: "r", isSource: true, node: root },
      charter: charter({ nodes: [source], tools: [charterSearch] }),
      executor,
    });

    machine.enqueueFrame({ messages: [{ ...textUserMessage("search") }] });

    await drain(runMachine(machine));

    const request = requestForRuntime(requests, "instance:r");
    expect(request.inference.tools.map((tool) => tool.description)).toEqual([
      "self",
      "source",
      "charter",
    ]);
  });

  it("does not inherit mounted ancestor bindings for string tool refs", async () => {
    const { executor, requests } = createRecordingExecutor();
    const baseSearch = createAction({ state: null, name: "search", description: "base" });
    const refinedSearch = createAction({ state: null, name: "search", description: "refined" });
    const requester = createNode({ key: "requester", tools: ["search"] });
    const owner = createNode({ key: "owner", tools: [refinedSearch], members: [requester] });
    const root = createNode({
      key: "root",
      tools: [baseSearch],
      members: [owner],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      instance: { id: "r", isSource: true, node: root },
      charter: charter({ tools: [baseSearch] }),
      executor,
    });

    machine.enqueueFrame({ messages: [{ ...textUserMessage("search") }] });

    await drain(runMachine(machine));

    const request = requestForRuntime(requests, "instance:r");
    expect(request.inference.tools.map((tool) => tool.description)).toEqual([
      "base",
      "refined",
      "base",
    ]);
  });

  it("falls back to charter tools when a string ref has no mounted binding", async () => {
    const { executor, requests } = createRecordingExecutor();
    const baseSearch = createAction({ state: null, name: "search", description: "base" });
    const root = createNode({
      key: "root",
      tools: ["search"],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      instance: { id: "r", isSource: true, node: root },
      charter: charter({ tools: [baseSearch] }),
      executor,
    });

    machine.enqueueFrame({ messages: [{ ...textUserMessage("search") }] });

    await drain(runMachine(machine));

    const request = requestForRuntime(requests, "instance:r");
    expect(request.inference.tools.map((tool) => tool.description)).toEqual(["base"]);
  });
});
