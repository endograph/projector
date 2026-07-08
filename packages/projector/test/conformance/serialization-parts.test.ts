import { describe, expect, it } from "vitest";
import {
  compileProjection,
  createAction,
  createComputedPart,
  createDiscriminator,
  createNode,
  createSlot,
  createSourceInstance,
  createState,
  createLayout,
  hydrateInstance,
  resolveStates,
  select,
  serializeInstance,
  text,
  tool,
  command,
  whenMember,
  type DryNode,
  type Instance,
  type SerializedInstance,
} from "../../index.ts";
import { charter } from "./helpers.ts";
import * as z from "zod";

const volatileSlot = createSlot("volatileInfo", { volatile: true });
const mode = createDiscriminator({
  name: "mode",
  values: ["terse", "verbose"],
  derive: ({ params }) => ((params as { verbose?: boolean }).verbose ? "verbose" : "terse"),
});
const computed = createComputedPart({
  name: "info",
  slot: volatileSlot,
  compute: () => "computed info",
});
const registeredSearch = createAction({ state: null, name: "search", description: "registered" });
const registeredNotify = createAction({ state: null, name: "notify", description: "notify" });

// A registered node carrying same-named respond variants in select branches —
// the branch-scoped recovery case.
const terseRespond = createAction({ state: null, name: "respond", description: "terse" });
const verboseRespond = createAction({ state: null, name: "respond", description: "verbose" });
const specialist = createNode({
  key: "specialist",
  params: z.object({ verbose: z.boolean().optional() }),
  parts: [
    text("specialist prose"),
    select(mode, {
      terse: [tool(terseRespond)],
      verbose: [tool(verboseRespond)],
    }),
  ],
});

function testCharter() {
  return charter({
    nodes: [specialist],
    tools: [registeredSearch],
    commands: [registeredNotify],
    discriminators: [mode],
    computedParts: [computed],
    slots: [volatileSlot],
    layouts: [
      createLayout({
        name: "doc",
        regions: {
          preamble: [createSlot("main", { default: true }), volatileSlot],
          recency: [],
        },
      }),
    ],
  });
}

function roundTrip(instance: Instance): Instance {
  const c = testCharter();
  const serialized = serializeInstance(instance, c);
  const rehydrated = hydrateInstance(
    JSON.parse(JSON.stringify(serialized)) as SerializedInstance,
    testCharter(),
  );
  return rehydrated;
}

describe("conformance: parts serialization", () => {
  it("registered nodes serialize as refs, parts never inline", () => {
    const instance = createSourceInstance({ id: "i", node: specialist });
    const serialized = serializeInstance(instance, testCharter());
    expect(serialized.node).toBe("specialist");
  });

  it("round-trips an inline variant of a registered node, branch variants included", () => {
    const inline = createNode({
      key: "patched",
      sourceNodeKey: "specialist",
      parts: [
        text("patched prose"),
        select(mode, {
          terse: [tool(terseRespond)],
          verbose: [tool(verboseRespond)],
        }),
        tool("search"),
        { kind: "computed" as const, part: computed },
      ],
    });
    const instance = createSourceInstance({ id: "i", node: inline });
    instance.params = {};
    resolveStates(instance);

    const serialized = serializeInstance(instance, testCharter());
    expect(typeof serialized.node).toBe("object");
    const dry = serialized.node as DryNode;
    expect(dry.sourceNodeKey).toBe("specialist");
    // Behavioral refs serialize as names only; code never serializes.
    expect(JSON.stringify(dry)).not.toContain('"run"');

    const rehydrated = roundTrip(instance);
    rehydrated.params = {};
    resolveStates(rehydrated);
    const compiled = compileProjection(rehydrated, { charter: testCharter() });
    const texts = compiled.preamble.map((part) => (part.type === "text" ? part.text : ""));
    expect(texts.join("\n")).toContain("patched prose");
    expect(texts.join("\n")).toContain("computed info");
    // The terse branch's respond resolves to the SOURCE node's terse variant.
    const respond = compiled.tools.find((t) => t.name === "respond");
    expect(respond?.description).toBe("terse");
    expect(compiled.tools.some((t) => t.name === "search")).toBe(true);
  });

  it("round-trips a de novo node (no sourceNodeKey) built from charter refs and data", () => {
    const deNovo = createNode({
      key: "denovo",
      parts: [
        text("de novo prose"),
        tool("search"),
        command("notify"),
        { kind: "computed" as const, part: "info" },
      ],
    });
    const instance = createSourceInstance({ id: "i", node: deNovo });
    const serialized = serializeInstance(instance, testCharter());
    const dry = serialized.node as DryNode;
    expect(dry.sourceNodeKey).toBeUndefined();

    const rehydrated = roundTrip(instance);
    const compiled = compileProjection(rehydrated, { charter: testCharter() });
    expect(compiled.preamble.some((p) => p.type === "text" && p.text.includes("de novo prose"))).toBe(true);
    expect(compiled.tools.map((t) => t.name)).toContain("search");
    // caller external stays off the tool surface after the round trip.
    expect(compiled.tools.map((t) => t.name)).not.toContain("notify");
  });

  it("rejects serializing an unregistered inline behavioral definition on a de novo node", () => {
    const rogueAction = createAction({ state: null, name: "rogue", run: () => "boom" });
    const deNovo = createNode({ key: "denovo", parts: [tool(rogueAction)] });
    const instance = createSourceInstance({ id: "i", node: deNovo });
    expect(() => serializeInstance(instance, testCharter())).toThrow(
      /Cannot serialize unregistered action "rogue"/,
    );
  });

  it("hard-errors on unknown refs at hydration", () => {
    const serialized: SerializedInstance = {
      id: "i",
      isSource: true,
      node: {
        key: "denovo",
        parts: [{ kind: "action", caller: "generator", ref: "vanished" }],
      },
    };
    expect(() => hydrateInstance(serialized, testCharter())).toThrow(
      /Unknown action ref "vanished" for node hydration/,
    );

    const unknownComputed: SerializedInstance = {
      id: "i",
      isSource: true,
      node: { key: "denovo", parts: [{ kind: "computed", ref: "vanished" }] },
    };
    expect(() => hydrateInstance(unknownComputed, testCharter())).toThrow(
      /Unknown computed part ref "vanished"/,
    );

    const unknownDiscriminator: SerializedInstance = {
      id: "i",
      isSource: true,
      node: {
        key: "denovo",
        parts: [
          { kind: "select", discriminator: "vanished", partial: true, branches: { a: [] } },
        ],
      },
    };
    expect(() => hydrateInstance(unknownDiscriminator, testCharter())).toThrow(
      /Unknown discriminator ref "vanished"/,
    );
  });

  it("round-trips member selects on inline nodes, array branches included", () => {
    const facet = createNode({ key: "facet", instructions: "facet prose" });
    const extra = createNode({ key: "extra", instructions: "extra prose" });
    const inline = createNode({
      key: "denovo",
      params: z.object({ verbose: z.boolean().optional() }),
      members: [whenMember(mode, "verbose", [facet, extra])],
    });
    const instance = createSourceInstance({ id: "i", node: inline });
    instance.params = { verbose: true };
    const rehydrated = roundTrip(instance);
    rehydrated.params = { verbose: true };
    const compiled = compileProjection(rehydrated, { charter: testCharter() });
    expect(compiled.preamble.some((p) => p.type === "text" && p.text.includes("facet prose"))).toBe(true);
    expect(compiled.preamble.some((p) => p.type === "text" && p.text.includes("extra prose"))).toBe(true);
  });

  it("binds stateful actions across round trips only through registered state descriptors", () => {
    const prefs = createState({
      key: "prefs",
      schema: z.object({ tone: z.string() }),
      init: { tone: "warm" },
    });
    const readPrefs = createAction({ state: prefs, name: "readPrefs" });

    // Registered descriptor: the ref hydrates to the same object, so the
    // action's identity-checked state binding survives the round trip.
    const registeredCharter = () => charter({ tools: [readPrefs], states: [prefs] });
    const registered = createNode({ key: "denovo", states: [prefs], parts: [tool("readPrefs")] });
    const rehydrated = hydrateInstance(
      JSON.parse(
        JSON.stringify(
          serializeInstance(createSourceInstance({ id: "i", node: registered }), registeredCharter()),
        ),
      ) as SerializedInstance,
      registeredCharter(),
    );
    resolveStates(rehydrated);
    const compiled = compileProjection(rehydrated, { charter: registeredCharter() });
    expect(compiled.tools.map((t) => t.name)).toContain("readPrefs");

    // Inline descriptor: hydration rebuilds the schema from JSON Schema, so
    // the charter action's schema-identity check fails at compile. Documented
    // sharp edge — stateful actions on serialized nodes need registered
    // descriptors. This may loosen to structural equivalence later.
    const inlineCharter = () => charter({ tools: [readPrefs] });
    const inline = createNode({
      key: "denovo",
      states: [{ key: "prefs", schema: z.object({ tone: z.string() }), init: { tone: "warm" } }],
      parts: [tool("readPrefs")],
    });
    const rehydratedInline = hydrateInstance(
      JSON.parse(
        JSON.stringify(
          serializeInstance(createSourceInstance({ id: "i", node: inline }), inlineCharter()),
        ),
      ) as SerializedInstance,
      inlineCharter(),
    );
    resolveStates(rehydratedInline);
    expect(() => compileProjection(rehydratedInline, { charter: inlineCharter() })).toThrow(
      /requires a different schema for state "prefs"/,
    );
  });
});
