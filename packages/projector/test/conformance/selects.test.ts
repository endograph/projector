import { describe, expect, it } from "vitest";
import {
  command,
  compileProjection,
  createAction,
  createCharter,
  createDiscriminator,
  createMachine,
  createNode,
  createSourceInstance,
  executeCommand,
  patchState,
  resolveStates,
  select,
  text,
  tool,
  when,
  whenMember,
  type Instance,
} from "../../index.ts";
import { charter, noopExecutor } from "./helpers.ts";
import * as z from "zod";

const modeState = {
  key: "prefs",
  schema: z.object({ verbose: z.boolean() }),
  init: { verbose: false },
};

function makeMode(deriveSpy?: { count: number }) {
  return createDiscriminator({
    name: "mode",
    values: ["terse", "verbose"],
    state: modeState,
    derive: ({ state }) => {
      if (deriveSpy) deriveSpy.count += 1;
      return (state as { verbose: boolean }).verbose ? "verbose" : "terse";
    },
  });
}

function sourceFor(node: ReturnType<typeof createNode>): Instance {
  const instance = createSourceInstance({ id: "i", node });
  resolveStates(instance);
  return instance;
}

function systemText(compiled: ReturnType<typeof compileProjection>): string {
  return compiled.preamble
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

describe("conformance: selects and discriminators", () => {
  it("selects part branches by resolved state, exhaustively", () => {
    const mode = makeMode();
    const node = createNode({
      key: "n",
      states: [modeState],
      parts: [
        select(mode, {
          terse: text("keep it short"),
          verbose: text("explain everything"),
        }),
      ],
    });
    const testCharter = charter({ nodes: [node], states: [modeState], discriminators: [mode] });

    const terse = sourceFor(node);
    expect(systemText(compileProjection(terse, { charter: testCharter }))).toContain("keep it short");

    const verbose = sourceFor(node);
    verbose.states = { prefs: { value: { verbose: true } } };
    expect(systemText(compileProjection(verbose, { charter: testCharter }))).toContain("explain everything");
  });

  it("supports when() partials and null branches contributing nothing", () => {
    const mode = makeMode();
    const node = createNode({
      key: "n",
      states: [modeState],
      parts: [
        text("always"),
        when(mode, "verbose", text("only when verbose")),
        select(mode, { terse: null, verbose: text("also verbose") }),
      ],
    });
    const testCharter = charter({ nodes: [node], states: [modeState], discriminators: [mode] });
    const rendered = systemText(compileProjection(sourceFor(node), { charter: testCharter }));
    expect(rendered).toContain("always");
    expect(rendered).not.toContain("only when verbose");
    expect(rendered).not.toContain("also verbose");
  });

  it("selects tools per branch so only the active mode's action compiles", () => {
    const mode = makeMode();
    const terseRespond = createAction({ state: null, name: "respond", description: "terse respond" });
    const verboseRespond = createAction({ state: null, name: "respond", description: "verbose respond" });
    const node = createNode({
      key: "n",
      states: [modeState],
      parts: [
        select(mode, {
          terse: tool(terseRespond),
          verbose: tool(verboseRespond),
        }),
      ],
    });
    const testCharter = charter({ nodes: [node], states: [modeState], discriminators: [mode] });
    const compiled = compileProjection(sourceFor(node), { charter: testCharter });
    expect(compiled.tools).toHaveLength(1);
    expect(compiled.tools[0]?.description).toBe("terse respond");
  });

  it("memoizes derive once per compile per container", () => {
    const spy = { count: 0 };
    const mode = makeMode(spy);
    const node = createNode({
      key: "n",
      states: [modeState],
      parts: [
        select(mode, { terse: text("a"), verbose: text("b") }),
        select(mode, { terse: text("c"), verbose: text("d") }),
        select(mode, { terse: text("e"), verbose: text("f") }),
      ],
    });
    const testCharter = charter({ nodes: [node], states: [modeState], discriminators: [mode] });
    compileProjection(sourceFor(node), { charter: testCharter });
    expect(spy.count).toBe(1);
  });

  it("falls back to the descriptor init when no container is in scope", () => {
    const mode = makeMode();
    // Node does NOT declare the state: no container provisions; derive still
    // totals via init.
    const node = createNode({
      key: "n",
      parts: [select(mode, { terse: text("from init"), verbose: text("wrong") })],
    });
    const testCharter = charter({ nodes: [node], discriminators: [mode] });
    const rendered = systemText(compileProjection(createSourceInstance({ id: "i", node }), { charter: testCharter }));
    expect(rendered).toContain("from init");
  });

  it("rejects derive values outside the declared set", () => {
    const rogue = createDiscriminator({
      name: "rogue",
      values: ["a", "b"],
      derive: () => "c" as "a",
    });
    const node = createNode({ key: "n", parts: [select(rogue, { a: text("a"), b: text("b") })] });
    const testCharter = charter({ nodes: [node], discriminators: [rogue] });
    expect(() => compileProjection(createSourceInstance({ id: "i", node }), { charter: testCharter })).toThrow(
      /derived invalid value "c"/,
    );
  });

  it("rejects non-exhaustive selects at construction", () => {
    const mode = makeMode();
    // The runtime exhaustiveness check lives in the sugar constructor (the
    // Record type enforces it for TS callers; the cast simulates a JS caller).
    expect(() =>
      select(mode, { terse: text("only one branch") } as Parameters<typeof select>[1]),
    ).toThrow(/missing branch "verbose"/);
  });

  it("accepts arrays in part-select branches and member-select branches", () => {
    const mode = makeMode();
    const facetA = createNode({ key: "facetA", instructions: "facet a prose" });
    const facetB = createNode({ key: "facetB", instructions: "facet b prose" });
    const node = createNode({
      key: "n",
      states: [modeState],
      parts: [
        select(mode, {
          terse: [text("terse one"), text("terse two")],
          verbose: null,
        }),
      ],
      members: [whenMember(mode, "terse", [facetA, facetB])],
    });
    const testCharter = charter({ nodes: [node], states: [modeState], discriminators: [mode] });
    const rendered = systemText(compileProjection(sourceFor(node), { charter: testCharter }));
    expect(rendered).toContain("terse one");
    expect(rendered).toContain("terse two");
    expect(rendered).toContain("facet a prose");
    expect(rendered).toContain("facet b prose");
  });

  it("emits action guidance with the contribution, atomically through selects", () => {
    const mode = makeMode();
    const terseRespond = createAction({ state: null, name: "respond", description: "terse" });
    const verboseRespond = createAction({ state: null, name: "respond", description: "verbose" });
    const notify = createAction({ state: null, name: "notify" });
    const node = createNode({
      key: "n",
      states: [modeState],
      parts: [
        select(mode, {
          terse: tool(terseRespond, { guidance: text("use respond tersely") }),
          verbose: tool(verboseRespond, { guidance: text("use respond verbosely") }),
        }),
        // External command guidance is model-facing even though the command
        // definition never reaches the tool surface.
        command(notify, { guidance: text("the app can be notified via notify") }),
      ],
    });
    const testCharter = charter({ nodes: [node], states: [modeState], discriminators: [mode] });
    const compiled = compileProjection(sourceFor(node), { charter: testCharter });
    const rendered = systemText(compiled);
    expect(rendered).toContain("use respond tersely");
    expect(rendered).not.toContain("use respond verbosely");
    expect(rendered).toContain("the app can be notified via notify");
    expect(compiled.tools.map((t) => t.name)).not.toContain("notify");
  });

  it("derives members from state and resolves their state into the parent scope", async () => {
    const mode = makeMode();
    const facetState = {
      key: "facet",
      schema: z.object({ count: z.number() }),
      init: { count: 7 },
    };
    const facet = createNode({
      key: "facet",
      instructions: "facet guidance",
      states: [facetState],
    });
    const setVerbose = createAction({
      state: modeState,
      name: "setVerbose",
      inputSchema: z.object({ verbose: z.boolean() }),
      run: ({ verbose }, ctx) => {
        ctx.updateState?.((current) => patchState({ ...(current as object), verbose }));
        return "ok";
      },
    });
    const host = createNode({
      key: "host",
      states: [modeState],
      commands: [setVerbose],
      members: [whenMember(mode, "verbose", facet)],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const testCharter = createCharter({
      nodes: [host, facet],
      commands: [setVerbose],
      states: [modeState, facetState],
      discriminators: [mode],
    });

    const instance = createSourceInstance({ id: "host-1", node: host });
    // Member state resolves in the parent scope even while the member is
    // derived OFF: state placement follows the skeleton, surface follows the
    // derivation. Existence follows the log — nothing attaches on a read.
    const facetResolved = resolveStates(instance).find((state) => state.address.stateKey === "facet");
    expect(facetResolved?.address).toEqual({ instanceId: "host-1", stateKey: "facet" });
    expect(facetResolved?.container.value).toEqual({ count: 7 });
    expect(facetResolved?.realized).toBe(false);
    expect(instance.states?.facet).toBeUndefined();

    const machine = createMachine({ instance, charter: testCharter, executor: noopExecutor() });
    const before = compileProjection(machine.instance, {
      charter: testCharter,
      targetGeneratorId: "instance:host-1",
    });
    expect(systemText(before)).not.toContain("facet guidance");

    await executeCommand(machine, {
      type: "action",
      kind: "request",
      action: "command",
      name: "setVerbose",
      input: { verbose: true },
      callId: "call-1",
    });

    const after = compileProjection(machine.instance, {
      charter: testCharter,
      targetGeneratorId: "instance:host-1",
    });
    expect(systemText(after)).toContain("facet guidance");
  });
});
