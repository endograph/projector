import { describe, expect, it } from "vitest";
import {
  compileProjection,
  createLayout,
  createNode,
  createSlot,
  createSourceInstance,
  resolveStates,
  textAssistantMessage,
  type ContentPart,
  type Frame,
} from "../../index.ts";
import { charter } from "./helpers.ts";
import * as z from "zod";

const prefs = { key: "prefs", schema: z.object({ tone: z.string() }), init: { tone: "warm" } };

function joined(parts: ContentPart[]): string {
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function compiledFor(node: ReturnType<typeof createNode>, extra: Parameters<typeof charter>[0] = {}) {
  const instance = createSourceInstance({ id: "i", node });
  resolveStates(instance);
  return compileProjection(instance, { charter: charter({ nodes: [node], ...extra }) });
}

describe("conformance: state projections", () => {
  it("hides state with no projection config, declaration and binding only", () => {
    const node = createNode({ key: "n", states: [prefs], instructions: "prose" });
    const compiled = compiledFor(node, { states: [prefs] });
    expect(joined(compiled.preamble)).not.toContain("prefs");
    expect(joined(compiled.recency)).not.toContain("prefs");
    expect(compiled.retrievableStates).toEqual([]);
  });

  it("renders a native state projection into its slot's region with default or custom rendering", () => {
    const recencySlot = createSlot("freshState", { volatile: true });
    const rendered = {
      ...prefs,
      key: "renderedPrefs",
      projection: { slot: recencySlot, render: (value: unknown) => `Tone is ${(value as { tone: string }).tone}.` },
    };
    const plain = { ...prefs, key: "plainPrefs", projection: {} };
    const node = createNode({ key: "n", states: [rendered, plain] });
    const compiled = compiledFor(node, {
      states: [rendered, plain],
      layouts: [
        createLayout({
          name: "doc",
          regions: {
            preamble: [createSlot("body", { default: true })],
            recency: [recencySlot],
          },
        }),
      ],
    });
    // Custom render, routed to the recency region by its slot.
    expect(joined(compiled.recency)).toContain("Tone is warm.");
    // Default render in the preamble default slot.
    expect(joined(compiled.preamble)).toContain('State `plainPrefs`: {"tone":"warm"}');
  });

  it("defers state behind getState with an overridable note", () => {
    const deferred = { ...prefs, key: "deferredPrefs", projection: { exposure: "deferred" as const } };
    const noted = {
      ...prefs,
      key: "notedPrefs",
      projection: {
        exposure: "deferred" as const,
        note: (address: string) => `Preferences live at ${address}; fetch only when personalizing.`,
      },
    };
    const node = createNode({ key: "n", states: [deferred, noted] });
    const compiled = compiledFor(node, { states: [deferred, noted] });
    expect(compiled.retrievableStates.map((state) => state.address).sort()).toEqual([
      "deferredPrefs",
      "notedPrefs",
    ]);
    expect(compiled.tools.map((tool) => tool.name)).toContain("getState");
    const system = joined(compiled.preamble);
    expect(system).toContain("You can call getState with address `deferredPrefs`");
    expect(system).toContain("Preferences live at notedPrefs; fetch only when personalizing.");
  });

  it("declares plural states on one node, all resolved and bound", () => {
    const a = { key: "alpha", schema: z.object({ v: z.number() }), init: { v: 1 }, projection: {} };
    const b = { key: "beta", schema: z.object({ v: z.number() }), init: { v: 2 }, projection: {} };
    const node = createNode({ key: "n", states: [a, b] });
    const instance = createSourceInstance({ id: "i", node });
    const resolved = resolveStates(instance);
    expect(resolved.map((state) => [state.address.stateKey, state.container.value])).toEqual([
      ["alpha", { v: 1 }],
      ["beta", { v: 2 }],
    ]);
    // Reads never realize: both states project from their init values below.
    expect(instance.states).toBeUndefined();
    const compiled = compileProjection(instance, { charter: charter({ nodes: [node], states: [a, b] }) });
    const system = joined(compiled.preamble);
    expect(system).toContain("State `alpha`");
    expect(system).toContain("State `beta`");
  });

  it("rejects duplicate state keys on one node", () => {
    expect(() => createNode({ key: "n", states: [prefs, { ...prefs }] })).toThrow(
      /Duplicate state "prefs"/,
    );
  });
});

describe("conformance: layout history projection", () => {
  it("renders history through the layout's projection, no per-node override", () => {
    const generator = createNode({
      key: "g",
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const layout = createLayout({
      name: "condensed",
      historyProjection: {
        kind: "historyProjection",
        name: "condense",
        method: (ctx) => [textAssistantMessage(`condensed ${ctx.history.length} frames`)],
      },
      regions: {
        preamble: [createSlot("body", { default: true })],
        recency: [createSlot("context", { default: true, volatile: true })],
      },
    });
    const frames: Frame[] = [
      { id: "f1", messages: [{ type: "user", text: "one" }] },
      { id: "f2", messages: [{ type: "user", text: "two" }] },
    ];
    const instance = createSourceInstance({ id: "g-1", node: generator });
    const compiled = compileProjection(instance, {
      charter: charter({ nodes: [generator], layouts: [layout] }),
      targetGeneratorId: "instance:g-1",
      frameHistory: frames,
    });
    expect(compiled.history).toEqual([textAssistantMessage("condensed 2 frames")]);
  });
});
