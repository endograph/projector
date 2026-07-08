import { describe, expect, it } from "vitest";
import {
  compileProjection,
  createComputedPart,
  createLayout,
  createNode,
  createSlot,
  createSourceInstance,
  resolveStates,
  text,
  type CompileDiagnostic,
  type ContentPart,
} from "../../index.ts";
import { charter } from "./helpers.ts";
import * as z from "zod";

const guidelines = createSlot("guidelines", { title: "Guidelines", merge: "list" });
const flow = createSlot("flow", { title: "Flow" });
const body = createSlot("body", { default: true });
const contextSlot = createSlot("context", { default: true, volatile: true });
const volatileTail = createSlot("volatileTail", { volatile: true });

function layoutCharter(overrides: Parameters<typeof charter>[0] = {}) {
  return charter({
    slots: [guidelines, flow, body, contextSlot, volatileTail],
    layouts: [
      createLayout({
        name: "doc",
        regions: {
          preamble: [body, guidelines, flow, volatileTail],
          recency: [contextSlot],
        },
      }),
    ],
    ...overrides,
  });
}

function systemText(parts: ContentPart[]): string {
  return parts.map((part) => (part.type === "text" ? part.text : `[[${part.type}]]`)).join("\n===\n");
}

describe("conformance: layout", () => {
  it("orders slots per the layout regardless of contribution order", () => {
    const node = createNode({
      parts: [
        text(flow, "step one"),
        text(guidelines, "rule a"),
        text("free prose"),
        text(guidelines, "rule b"),
      ],
      key: "n",
    });
    const compiled = compileProjection(createSourceInstance({ id: "i", node }), {
      charter: layoutCharter({ nodes: [node] }),
    });
    const rendered = systemText(compiled.preamble);
    expect(rendered).toBe(
      "free prose\n===\nGuidelines:\n===\n- rule a\n- rule b\n===\nFlow:\n===\nstep one",
    );
  });

  it("merges list slots as bullets and titles render once", () => {
    const node = createNode({
      key: "n",
      parts: [text(guidelines, "one"), text(guidelines, "two"), text(guidelines, "three")],
    });
    const compiled = compileProjection(createSourceInstance({ id: "i", node }), {
      charter: layoutCharter({ nodes: [node] }),
    });
    const rendered = systemText(compiled.preamble);
    expect(rendered).toBe("Guidelines:\n===\n- one\n- two\n- three");
  });

  it("coheres unknown slots at the region tail with a warning diagnostic", () => {
    const node = createNode({
      key: "n",
      parts: [text("proposed-slot", "novel content"), text("prose")],
    });
    const diagnostics: CompileDiagnostic[] = [];
    const compiled = compileProjection(createSourceInstance({ id: "i", node }), {
      charter: layoutCharter({ nodes: [node] }),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(systemText(compiled.preamble)).toBe("prose\n===\nnovel content");
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "unknown-slot", severity: "warning" }),
    );
    expect(compiled.diagnostics).toContainEqual(expect.objectContaining({ code: "unknown-slot" }));
  });

  it("errors on unknown slots when the layout is strict", () => {
    const node = createNode({ key: "n", parts: [text("typo-slot", "content")] });
    const strict = charter({
      slots: [body],
      layouts: [
        createLayout({ name: "strictDoc", strict: true, regions: { preamble: [body], recency: [] } }),
      ],
      nodes: [node],
    });
    expect(() =>
      compileProjection(createSourceInstance({ id: "i", node }), { charter: strict }),
    ).toThrow(/Unknown slot "typo-slot"/);
  });

  it("evaluates computed parts from params and state, string and content-part forms", () => {
    const stateDescriptor = {
      key: "prefs",
      schema: z.object({ tone: z.string() }),
      init: { tone: "warm" },
    };
    const fromBoth = createComputedPart({
      name: "fromBoth",
      slot: volatileTail,
      compute: ({ params, state }) =>
        `user=${(params as { userId?: string }).userId} tone=${(state(stateDescriptor) as { tone: string }).tone}`,
    });
    const asParts = createComputedPart({
      name: "asParts",
      slot: contextSlot,
      compute: () => [
        { type: "text", text: "computed content part" },
        { type: "image", data: "aGk=", mediaType: "image/png" },
      ],
    });
    const node = createNode({
      key: "n",
      params: z.object({ userId: z.string() }),
      states: [stateDescriptor],
      parts: [fromBoth, asParts],
    });
    const instance = createSourceInstance({ id: "i", node });
    instance.params = { userId: "u1" };
    resolveStates(instance);
    const compiled = compileProjection(instance, {
      charter: layoutCharter({ nodes: [node], states: [stateDescriptor] }),
    });
    expect(systemText(compiled.preamble)).toContain("user=u1 tone=warm");
    expect(compiled.recency.some((part) => part.type === "image")).toBe(true);
    expect(compiled.recency.some((part) => part.type === "text" && part.text.includes("computed content part"))).toBe(true);
  });

  it("rejects computed parts targeting non-volatile slots at charter build", () => {
    const bad = createComputedPart({ name: "bad", slot: guidelines, compute: () => "x" });
    expect(() => layoutCharter({ computedParts: [bad] })).toThrow(/non-volatile slot/);
  });

  it("rejects layouts ordering stable slots after volatile ones at charter build", () => {
    expect(() =>
      charter({
        layouts: [
          createLayout({
            name: "bad",
            regions: { preamble: [volatileTail, guidelines], recency: [] },
          }),
        ],
      }),
    ).toThrow(/volatile/);
  });

  it("stamps every compiled part with slot identity and volatility, never draft placement", () => {
    const node = createNode({
      key: "n",
      parts: [
        text(guidelines, "rule"),
        text(flow, "step"),
        text("prose"),
        text(contextSlot, "fresh"),
        text("proposed-slot", "novel"),
      ],
    });
    const compiled = compileProjection(createSourceInstance({ id: "i", node }), {
      charter: layoutCharter({ nodes: [node] }),
      onDiagnostic: () => {},
    });
    for (const part of [...compiled.preamble, ...compiled.recency]) {
      expect(typeof part.slot).toBe("string");
      expect(typeof part.volatile).toBe("boolean");
      expect(part.region).toBeUndefined();
      expect(part.partDepth).toBeUndefined();
    }
    // Title parts carry the owning slot; unknown slots keep their name, volatile.
    expect(compiled.preamble).toContainEqual({
      type: "text",
      text: "Guidelines:",
      slot: "guidelines",
      volatile: false,
    });
    expect(compiled.preamble).toContainEqual({
      type: "text",
      text: "novel",
      slot: "proposed-slot",
      volatile: true,
    });
    expect(compiled.recency).toContainEqual({
      type: "text",
      text: "fresh",
      slot: "context",
      volatile: true,
    });
    // Stable parts precede volatile parts within each region.
    for (const region of [compiled.preamble, compiled.recency]) {
      const firstVolatile = region.findIndex((part) => part.volatile);
      if (firstVolatile === -1) continue;
      expect(region.slice(firstVolatile).every((part) => part.volatile)).toBe(true);
    }
  });

  it("routes parts addressed to recency slots into recency", () => {
    const node = createNode({ key: "n", parts: [text(contextSlot, "fresh info"), text("stable")] });
    const compiled = compileProjection(createSourceInstance({ id: "i", node }), {
      charter: layoutCharter({ nodes: [node] }),
    });
    expect(systemText(compiled.preamble)).toBe("stable");
    expect(systemText(compiled.recency)).toBe("fresh info");
  });

  it("renders identically through the implicit default layout when no layout is registered", () => {
    const node = createNode({ key: "n", instructions: "hello world" });
    const compiled = compileProjection(createSourceInstance({ id: "i", node }), {
      charter: charter({ nodes: [node] }),
    });
    expect(systemText(compiled.preamble)).toBe("hello world");
  });
});
