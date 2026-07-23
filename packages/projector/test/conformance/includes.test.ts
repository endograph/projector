import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  compileProjection,
  createAction,
  createCharter,
  createComputedPart,
  createMachine,
  createNode,
  createState,
  hydrateInstance,
  include,
  recencyRegion,
  runMachine,
  serializeInstance,
  text,
  textUserMessage,
  type CompiledInference,
  type InstanceMessage,
} from "../../index.ts";
import { charter, createRecordingExecutor, drain, requestForRuntime } from "./helpers.ts";

/** Merged body text of the implicit layout's preamble. */
function bodyText(inference: CompiledInference<any>): string {
  return inference.preamble
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function diagnosticCodes(inference: CompiledInference<any>): string[] {
  return (inference.diagnostics ?? []).map((diagnostic) => diagnostic.code);
}

// Includes: instance-based composition. An include is a compile-layer part —
// a view of the living contributor the node key resolves to via nearest
// enclosing scope matching — never a second mount: the target renders
// canonically (its own state containers, its own params) at the include
// site's position, once per document.
describe("conformance: includes (instance-based composition)", () => {
  it("splices the target's canonical rendering at the include-site position; the canonical document is unchanged", () => {
    const ctx = createNode({ key: "ctx", instructions: "shared context" });
    const agent = createNode({
      key: "agent",
      parts: [include(ctx), text("agent instructions")],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const home = createNode({
      key: "home",
      instructions: "home base",
      members: [ctx, agent],
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const projectorCharter = createCharter({ nodes: [home, ctx, agent] });
    const instance = { id: "r", isSource: true, node: home };

    const agentDoc = compileProjection(instance, {
      charter: projectorCharter,
      targetGeneratorId: "member:r/agent",
    });
    // Position: the include is part 0, so the target's content precedes the
    // includer's own text; content is byte-identical to the canonical text.
    expect(bodyText(agentDoc)).toBe("shared context\n\nagent instructions");
    expect(diagnosticCodes(agentDoc)).toEqual([]);

    // The canonical document still renders the target once, at its mount.
    const homeDoc = compileProjection(instance, {
      charter: projectorCharter,
      targetGeneratorId: "instance:r",
    });
    expect(bodyText(homeDoc)).toBe("home base\n\nshared context");
  });

  it("NESM: the nearest enclosing scope's mount shadows an outer mount of the same key (ambient members), binding the target's canonical state", () => {
    // Local scope so the state PRESENTS at the ambient contributor itself
    // (hoist states present at their owning source instance's contributor —
    // the include stays byte-identical to that canonical placement either
    // way, this just makes the binding observable in the included rendering).
    const ambientState = createState({
      key: "amb",
      schema: z.string(),
      init: "unset",
      scope: "local",
      projection: {},
    });
    const ambient = createNode({ key: "ambient", states: [ambientState] });
    const spec = createNode({
      key: "spec",
      parts: [include(ambient)],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const thread = createNode({
      key: "thread",
      members: [ambient],
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const projectorCharter = createCharter({ nodes: [ambient, thread, spec] });

    const outerMount = {
      id: "amb",
      isSource: true,
      node: ambient,
      states: { amb: { value: "far" } },
    };
    const threadInstance = {
      id: "t",
      isSource: true,
      node: thread,
      states: { amb: { value: "near" } },
      children: [{ id: "spec", node: spec }],
    };

    const specDoc = compileProjection([outerMount, threadInstance], {
      charter: projectorCharter,
      targetGeneratorId: "instance:spec",
    });
    // Resolution walked outward from spec's scope and stopped at thread's —
    // the nearer mount wins, and its state resolves at the target's canonical
    // containers (hoisted to the thread source), not the outer mount's.
    expect(bodyText(specDoc)).toContain('"near"');
    expect(bodyText(specDoc)).not.toContain('"far"');
    expect(diagnosticCodes(specDoc)).toEqual([]);
  });

  it("NESM terminates at a non-generator root instance and reports a miss loudly", () => {
    const ctx = createNode({ key: "ctx", instructions: "vessel context" });
    const incl = createNode({
      key: "incl",
      parts: [include(ctx), include("nowhere")],
    });
    const vessel = createNode({
      key: "vessel",
      instructions: "vessel",
      members: [incl, ctx],
    });

    // A bare component root is a scope root too (any parentless instance) —
    // without it the walk would have nowhere to terminate.
    const doc = compileProjection({ id: "v", node: vessel });
    // include(ctx) resolved at the root scope and rendered the target at the
    // include site; the later canonical mount clipped (once per document).
    expect(occurrences(bodyText(doc), "vessel context")).toBe(1);
    expect(doc.diagnostics).toContainEqual(
      expect.objectContaining({ code: "clipped-include", severity: "warning" }),
    );
    // include("nowhere") missed in every enclosing scope: loud, never silent.
    expect(doc.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "unresolved-include",
        severity: "error",
        message: expect.stringContaining('"nowhere"'),
      }),
    );
  });

  it("include-of-parent resolves to the enclosing scope root and yields everything except the includer — no cycle", () => {
    const observations = createNode({ key: "observations", instructions: "observations" });
    const parent = createNode({
      key: "parent",
      instructions: "parent context",
      members: [observations],
      runtime: {
        type: "generator",
        trigger: { type: "primary" },
        boundaryProjection: "augment",
      },
    });
    const spec = createNode({
      key: "spec",
      parts: [include("parent"), text("spec instructions")],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const projectorCharter = createCharter({ nodes: [parent, observations, spec] });

    const doc = compileProjection(
      {
        id: "p",
        isSource: true,
        node: parent,
        children: [{ id: "spec", node: spec }],
      },
      { charter: projectorCharter, targetGeneratorId: "instance:spec" },
    );

    // The parent's parts and component members forward; the includer itself
    // is a hidden boundary inside the parent's subtree, so the walk never
    // recurses back into it.
    expect(bodyText(doc)).toBe("parent context\n\nobservations\n\nspec instructions");
    expect(diagnosticCodes(doc)).toEqual([]);
  });

  it("diamond include: a target reached through two includes renders once, later visits clip with a diagnostic", () => {
    const ctx = createNode({ key: "ctx", instructions: "shared context" });
    const left = createNode({ key: "left", parts: [text("left"), include(ctx)] });
    const right = createNode({ key: "right", parts: [text("right"), include(ctx)] });
    const agent = createNode({
      key: "agent",
      members: [left, right],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const projectorCharter = createCharter({ nodes: [ctx, left, right, agent] });

    const doc = compileProjection(
      [
        { id: "c", isSource: true, node: ctx },
        { id: "a", isSource: true, node: agent },
      ],
      { charter: projectorCharter, targetGeneratorId: "instance:a" },
    );

    expect(occurrences(bodyText(doc), "shared context")).toBe(1);
    // First visit wins: the shared target rendered under the first include.
    expect(bodyText(doc)).toBe("left\n\nshared context\n\nright");
    expect(diagnosticCodes(doc).filter((code) => code === "clipped-include")).toHaveLength(1);
  });

  it("self-include is a no-op with a diagnostic (and trips the static cycle lint)", () => {
    const selfy = createNode({
      key: "selfy",
      parts: [include("selfy"), text("own instructions")],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const projectorCharter = createCharter({ nodes: [selfy] });

    const doc = compileProjection(
      { id: "s", isSource: true, node: selfy },
      { charter: projectorCharter, targetGeneratorId: "instance:s" },
    );

    expect(bodyText(doc)).toBe("own instructions");
    expect(doc.diagnostics).toContainEqual(
      expect.objectContaining({ code: "clipped-include" }),
    );
    expect(doc.diagnostics).toContainEqual(
      expect.objectContaining({ code: "cyclic-include", severity: "warning" }),
    );
  });

  it("mutual includes are defined behavior (each renders the other minus itself) and lint as a static cycle", () => {
    const alpha = createNode({ key: "alpha", parts: [text("alpha"), include("beta")] });
    const beta = createNode({ key: "beta", parts: [text("beta"), include("alpha")] });
    const agent = createNode({
      key: "agent",
      members: [alpha, beta],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const projectorCharter = createCharter({ nodes: [alpha, beta, agent] });

    const doc = compileProjection(
      { id: "a", isSource: true, node: agent },
      { charter: projectorCharter, targetGeneratorId: "instance:a" },
    );

    expect(occurrences(bodyText(doc), "alpha")).toBe(1);
    expect(occurrences(bodyText(doc), "beta")).toBe(1);
    expect(doc.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "cyclic-include",
        message: expect.stringContaining("->"),
      }),
    );
  });

  it("routes generator includes through the boundary law: hidden contributes nothing (+ diagnostic), augment forwards parts", () => {
    const hidden = createNode({
      key: "hiddenGen",
      instructions: "private business",
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const augMember = createNode({ key: "augMember", instructions: "aug member" });
    const augmented = createNode({
      key: "augGen",
      instructions: "exported",
      members: [augMember],
      runtime: {
        type: "generator",
        trigger: { type: "parent-completion" },
        boundaryProjection: "augment",
      },
    });
    const agent = createNode({
      key: "agent",
      parts: [include("hiddenGen"), include("augGen"), text("agent own")],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const projectorCharter = createCharter({ nodes: [hidden, augMember, augmented, agent] });

    const doc = compileProjection(
      [
        { id: "h", isSource: true, node: hidden },
        { id: "g", isSource: true, node: augmented },
        { id: "a", isSource: true, node: agent },
      ],
      { charter: projectorCharter, targetGeneratorId: "instance:a" },
    );

    expect(bodyText(doc)).toBe("exported\n\naug member\n\nagent own");
    expect(bodyText(doc)).not.toContain("private business");
    expect(doc.diagnostics).toContainEqual(
      expect.objectContaining({ code: "hidden-include", severity: "warning" }),
    );
  });

  it("dedups double state projection: canonical mount plus include of it projects the state once", () => {
    const noteState = createState({
      key: "note",
      schema: z.string(),
      init: "remember this",
      scope: "local",
      projection: {},
    });
    const noted = createNode({ key: "noted", states: [noteState] });
    const incl = createNode({ key: "incl", parts: [include(noted)] });
    const agent = createNode({
      key: "agent",
      members: [incl, noted],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const projectorCharter = createCharter({ nodes: [noted, incl, agent] });

    const doc = compileProjection(
      { id: "a", isSource: true, node: agent },
      { charter: projectorCharter, targetGeneratorId: "instance:a" },
    );

    expect(occurrences(bodyText(doc), "remember this")).toBe(1);
    expect(doc.diagnostics).toContainEqual(
      expect.objectContaining({ code: "clipped-include" }),
    );
  });

  it("dispatch decouples caller from owner: an included tool writes the target's canonical containers, spawns under the target instance, and its frames attribute to the caller", async () => {
    const counterState = createState({ key: "count", schema: z.number(), init: 0 });
    const worker = createNode({ key: "worker", instructions: "worker" });
    const bump = createAction({
      state: counterState,
      name: "bump",
      run: (_input: unknown, ctx) => {
        ctx.updateState?.({ op: "replace", value: 5 });
        return "bumped";
      },
    });
    const delegate = createAction({
      state: null,
      name: "delegate",
      run: (_input: unknown, ctx) => {
        ctx.instance.spawn(worker);
        return "delegated";
      },
    });
    const ctxTools = createNode({
      key: "ctxTools",
      states: [counterState],
      tools: [bump, delegate],
    });
    const spec = createNode({
      key: "spec",
      parts: [include(ctxTools)],
      runtime: { type: "generator", trigger: { type: "primary", suppressAncestors: true } },
    });
    const home = createNode({
      key: "home",
      members: [ctxTools],
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const projectorCharter = charter({ nodes: [home, ctxTools, spec, worker] });

    const { executor, requests } = createRecordingExecutor(async (request) => {
      if (request.generatorId !== "instance:spec") {
        return { completionReason: "done" };
      }
      const bumpTool = request.inference.tools.find((tool) => tool.name === "bump");
      const delegateTool = request.inference.tools.find((tool) => tool.name === "delegate");
      await bumpTool?.run?.({}, request.createActionContext?.(bumpTool) as never);
      await delegateTool?.run?.({}, request.createActionContext?.(delegateTool) as never);
      return { completionReason: "done" };
    });
    const machine = createMachine({
      id: "include-dispatch-demo",
      instance: { id: "r", isSource: true, node: home },
      charter: projectorCharter,
      executor,
    });
    machine.enqueueFrame({
      messages: [
        {
          type: "instance",
          kind: "spawn",
          parentInstanceId: "r",
          children: [{ id: "spec", node: "spec" }],
        },
      ],
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("go") }] });

    const frames = await drain(runMachine(machine));

    // The floor gave spec the turn; its document carried the included tools.
    const request = requestForRuntime(requests, "instance:spec");
    expect(request.inference.tools.map((tool) => tool.name).sort()).toEqual([
      "bump",
      "delegate",
    ]);

    // ctx.state wrote the CANONICAL container: the target member hoists to the
    // home source instance "r", not anywhere under the caller.
    expect(machine.instance.states?.count?.value).toBe(5);
    const stateFrame = frames.find((frame) =>
      frame.messages.some(
        (message) => message.type === "instance" && message.kind === "state.update",
      ),
    );
    expect(stateFrame?.messages[0]).toMatchObject({
      kind: "state.update",
      instanceId: "r",
      stateKey: "count",
    });
    // The action FRAME attributes to the caller; the mutation landed at the
    // owner's address.
    expect(stateFrame?.generatorId).toBe("instance:spec");

    // Spawn lands where the target lives, not where it rendered: under the
    // owning member's instance ("r"), a sibling of spec.
    const spawnFrame = frames.find((frame) =>
      frame.messages.some(
        (message) =>
          message.type === "instance" &&
          message.kind === "spawn" &&
          (message.children as Array<{ node: unknown }>).some((child) => child.node === "worker"),
      ),
    );
    const spawnMessage = spawnFrame?.messages[0] as InstanceMessage & { kind: "spawn" };
    expect(spawnMessage.parentInstanceId).toBe("r");
    expect(spawnFrame?.generatorId).toBe("instance:spec");
    expect(
      machine.instance.children?.map((child) => child.node.key).sort(),
    ).toEqual(["spec", "worker"]);
  });

  it("shadows same-name tools by the include SITE's depth: the includer's own deeper part beats an included tool", () => {
    const farReport = createAction({ state: null, name: "report", description: "far variant" });
    const nearReport = createAction({ state: null, name: "report", description: "near variant" });
    const reportCtx = createNode({ key: "reportCtx", tools: [farReport] });
    const inner = createNode({ key: "inner", members: [reportCtx] });
    const wrapper = createNode({ key: "wrapper", members: [inner] });
    const deep = createNode({ key: "deep", tools: [nearReport] });
    const agent = createNode({
      key: "agent",
      parts: [include("reportCtx")],
      members: [deep],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const projectorCharter = createCharter({ nodes: [wrapper, inner, reportCtx, deep, agent] });

    const doc = compileProjection(
      [
        { id: "w", isSource: true, node: wrapper },
        { id: "a", isSource: true, node: agent },
      ],
      { charter: projectorCharter, targetGeneratorId: "instance:a" },
    );

    // Canonically the target sits at depth 3 (root/wrapper/inner/reportCtx),
    // which would out-rank the includer's member at depth 2. The include
    // grafts it at the SITE's depth (1), so the includer's own deeper member
    // wins the collision — decidable from the includer's document alone.
    expect(doc.tools.map((tool) => tool.name)).toEqual(["report"]);
    expect(doc.tools[0]?.description).toBe("near variant");
    expect(doc.diagnostics).toContainEqual(
      expect.objectContaining({ code: "shadowed-action" }),
    );
  });

  it("reports a scope-uniqueness violation in the matched scope loudly instead of silently picking", () => {
    const dup = createNode({ key: "dup", instructions: "which one?" });
    const agent = createNode({
      key: "agent",
      parts: [include("dup"), text("agent own")],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });

    // Assembled directly (assembly is not the enforcement point; mutations
    // are), so the compile-realization backstop must speak up.
    const doc = compileProjection(
      {
        id: "r",
        isSource: true,
        node: agent,
        children: [
          { id: "d1", node: dup },
          { id: "d2", node: dup },
        ],
      },
      { targetGeneratorId: "instance:r" },
    );

    expect(doc.diagnostics).toContainEqual(
      expect.objectContaining({ code: "ambiguous-include", severity: "error" }),
    );
    // Never a silent pick: the include contributed nothing. The canonical
    // mounts still render as themselves.
    expect(bodyText(doc)).toBe("agent own\n\nwhich one?\n\nwhich one?");
  });

  it("rejects a spawn that would duplicate a node key in one scope; the same key in different scopes is legal", async () => {
    const dup = createNode({ key: "dup", instructions: "dup" });
    const sub = createNode({
      key: "sub",
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const home = createNode({
      key: "home",
      runtime: { type: "generator", trigger: { type: "primary" } },
    });
    const machine = createMachine({
      id: "scope-uniqueness-demo",
      instance: { id: "r", isSource: true, node: home },
      charter: charter({ nodes: [dup, sub] }),
    });

    const spawnUnder = (parentInstanceId: string, id: string, node: string) =>
      machine.enqueueFrame({
        messages: [
          {
            type: "instance",
            kind: "spawn",
            parentInstanceId,
            children: [{ id, node }],
          },
        ],
      });

    spawnUnder("r", "d1", "dup");
    spawnUnder("r", "sub1", "sub");
    // Same key under the nested generator's OWN scope: legal — per-scope
    // uniqueness legalizes deliberate duplication across scopes.
    spawnUnder("sub1", "d2", "dup");

    // A second "dup" in the root generator's scope is rejected at the
    // mutation, atomically (the transactional fold dry-runs first).
    expect(() => spawnUnder("r", "d3", "dup")).toThrow(/scope|node key "dup"/);
    // The rejected frame had no effect at all (transactional fold).
    expect(machine.instance.children?.map((child) => child.id).sort()).toEqual([
      "d1",
      "sub1",
    ]);
    const nested = machine.instance.children?.find((child) => child.id === "sub1");
    expect(nested?.children?.map((child) => child.id)).toEqual(["d2"]);
  });

  it("rejects duplicate node keys in a registered generator's walkable member tree at createCharter", () => {
    const dupA = createNode({ key: "dup", instructions: "a" });
    const dupB = createNode({ key: "dup", instructions: "b" });
    const holder = createNode({ key: "holder", members: [dupB] });
    const gen = createNode({
      key: "gen",
      members: [dupA, holder],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });

    expect(() => createCharter({ nodes: [gen] })).toThrow(/Scope-uniqueness.*"dup"/);
  });

  it("computed includes choose among the declared registry and are rejected when conjured", () => {
    const ctx = createNode({ key: "ctx", instructions: "computed context" });
    const other = createNode({ key: "other", instructions: "conjured" });
    const declared = createComputedPart({
      name: "declaredInclude",
      slot: recencyRegion,
      registry: [ctx],
      compute: () => [include(ctx)],
    });
    const conjuring = createComputedPart({
      name: "conjuringInclude",
      slot: recencyRegion,
      registry: [ctx],
      compute: () => [include(other)],
    });
    const okAgent = createNode({
      key: "okAgent",
      parts: [declared],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const badAgent = createNode({
      key: "badAgent",
      parts: [conjuring],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const projectorCharter = createCharter({ nodes: [ctx, other, okAgent, badAgent] });

    const doc = compileProjection(
      [
        { id: "c", isSource: true, node: ctx },
        { id: "a", isSource: true, node: okAgent },
      ],
      { charter: projectorCharter, targetGeneratorId: "instance:a" },
    );
    expect(bodyText(doc)).toContain("computed context");

    expect(() =>
      compileProjection(
        [
          { id: "o", isSource: true, node: other },
          { id: "b", isSource: true, node: badAgent },
        ],
        { charter: projectorCharter, targetGeneratorId: "instance:b" },
      ),
    ).toThrow(/never conjured/);
  });

  it("serializes include parts by node key, hydrates them back, and refuses unregistered targets at createCharter", () => {
    const ctx = createNode({ key: "ctx", instructions: "shared context" });
    const projectorCharter = createCharter({ nodes: [ctx] });

    const custom = createNode({
      key: "custom",
      parts: [include(ctx), text("custom text")],
    });
    const serialized = serializeInstance({ id: "c", node: custom }, projectorCharter);
    expect(serialized.node).toMatchObject({
      key: "custom",
      parts: [
        { kind: "include", node: "ctx" },
        { kind: "text", text: "custom text" },
      ],
    });

    const hydrated = hydrateInstance(serialized, projectorCharter);
    expect(hydrated.node.parts[0]).toEqual({ kind: "include", node: ctx });
    // The hydrated include resolves to the registered node object itself.
    expect((hydrated.node.parts[0] as { node: unknown }).node).toBe(ctx);

    // The same law as spawn: every included node must be charter-registered.
    const unregistered = createNode({ key: "ghost", instructions: "ghost" });
    const includer = createNode({
      key: "includer",
      parts: [include(unregistered)],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    expect(() => createCharter({ nodes: [includer] })).toThrow(/charter-registered/);
  });

  it("included parts keep their own slot addresses; a slot unknown to the includer's layout follows the pseudo-slot law", () => {
    const ctx = createNode({
      key: "ctx",
      parts: [text("sidebar", "sidebar note")],
    });
    const agent = createNode({
      key: "agent",
      parts: [include(ctx), text("agent own")],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const projectorCharter = createCharter({ nodes: [ctx, agent] });

    const doc = compileProjection(
      [
        { id: "c", isSource: true, node: ctx },
        { id: "a", isSource: true, node: agent },
      ],
      { charter: projectorCharter, targetGeneratorId: "instance:a" },
    );

    expect(doc.diagnostics).toContainEqual(
      expect.objectContaining({ code: "unknown-slot" }),
    );
    // Pseudo-slot at the region tail, stamped volatile, keeping its name.
    expect(doc.preamble.at(-1)).toMatchObject({
      type: "text",
      text: "sidebar note",
      slot: "sidebar",
      volatile: true,
    });
  });
});
