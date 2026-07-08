import { describe, expect, it } from "vitest";
import { collectAllNodeActions, createMachine, createNode, createAction, runMachine, textUserMessage } from "../../index.ts";
import { charter, createRecordingExecutor, drain, requestForRuntime } from "./helpers.ts";

describe("conformance: projected tools", () => {
  it("dedupes duplicate tools with deepest contributor winning", async () => {
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
    expect(request.inference.tools).toHaveLength(1);
    expect(request.inference.tools[0]?.description).toBe("override");
    expect(request.inference.diagnostics).toContainEqual(
      expect.objectContaining({ code: "shadowed-action" }),
    );
  });

  it("resolves string tool refs through self, source node, then charter", async () => {
    const { executor, requests } = createRecordingExecutor();
    const charterSearch = createAction({ state: null, name: "charterSearch", description: "charter" });
    const sourceSearch = createAction({ state: null, name: "sourceSearch", description: "source" });
    const selfSearch = createAction({ state: null, name: "selfSearch", description: "self" });
    const source = createNode({ key: "source", tools: [sourceSearch] });
    const self = createNode({ key: "self", sourceNodeKey: "source", tools: [selfSearch, "selfSearch"] });
    const sourced = createNode({ key: "sourced", sourceNodeKey: "source", tools: ["sourceSearch"] });
    const global = createNode({ key: "global", tools: ["charterSearch"] });
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
    expect(request.inference.tools).toHaveLength(1);
    expect(request.inference.tools[0]?.description).toBe("base");
    expect(request.inference.diagnostics).toContainEqual(
      expect.objectContaining({ code: "shadowed-action" }),
    );
  });

  it("resolves a shared action name through self parts, then source parts, then charter", () => {
    const charterSearch = createAction({ state: null, name: "search", description: "charter" });
    const sourceSearch = createAction({ state: null, name: "search", description: "source" });
    const selfSearch = createAction({ state: null, name: "search", description: "self" });
    const source = createNode({ key: "source", tools: [sourceSearch] });
    // A string ref alongside a same-named inline action resolves to the
    // inline one (self tier), before the source node or the charter.
    const self = createNode({ key: "self", sourceNodeKey: "source", tools: [selfSearch, "search"] });
    const sourced = createNode({ key: "sourced", sourceNodeKey: "source", tools: ["search"] });
    const global = createNode({ key: "global", tools: ["search"] });
    const testCharter = charter({ nodes: [source, self, sourced, global], tools: [charterSearch] });

    const descriptionsFor = (node: ReturnType<typeof createNode>) =>
      collectAllNodeActions(node, testCharter).map((entry) => entry.action.description);
    expect(descriptionsFor(self)).toEqual(["self", "self"]);
    expect(descriptionsFor(sourced)).toEqual(["source"]);
    expect(descriptionsFor(global)).toEqual(["charter"]);
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
