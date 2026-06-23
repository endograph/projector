import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  actorMessages,
  appendState,
  applyStaticProjection,
  compileProjection,
  createActivationFrame,
  createCompletionFrame,
  createCharter,
  createAction,
  createMachine,
  createHistoryProjectionFunction,
  createProjectionFunction,
  createRuntimeCompletionFrame,
  createRuntimeTurnFrame,
  createNode,
  createRoot,
  executeCommand,
  hydrateHistoryProjection,
  hydrateInstance,
  hydrateNode,
  hydrateProjection,
  hydrateStateDescriptor,
  inspectCompiledProjectionTree,
  isActorMessage,
  messagesBeforeLastCompletion,
  messagesSinceLastCompletion,
  patchState,
  resolveStates,
  replaceState,
  runMachine,
  serializeHistoryProjection,
  serializeInstance,
  serializeNode,
  serializeProjection,
  serializeStateDescriptor,
  syncMachineRuntime,
  textAssistantMessage,
  textUserMessage,
  ROOT_RUNTIME_INSTANCE_ID,
  collectProjectionNodes,
  type Action,
  type ActorMessage,
  type Charter,
  type CharterConfig,
  type CompiledInference,
  type ContentPart,
  type ExecutorRunRequest,
  type Frame,
  type Instance,
} from "../../index.ts";

const executor = {
  run: () => ({ completionReason: "done" as const }),
  realizePrompt: (request: { inference: unknown }) => ({ provider: "test", input: request.inference }),
};

function textParts(...texts: string[]) {
  return texts.map((text) => ({ type: "text" as const, text }));
}

function charter<TDataContent = never>(
  overrides: Partial<CharterConfig<TDataContent>> = {},
): Charter<TDataContent> {
  return createCharter<TDataContent>({
    executor: executor as Charter<TDataContent>["executor"],
    nodes: [],
    tools: [],
    commands: [],
    states: [],
    projections: [],
    ...overrides,
  });
}

describe("actor message typing", () => {
  it("allows text-only actor messages while preserving typed data content parts", () => {
    type AppDataContent =
      | { answer: string }
      | { blocks: Array<{ type: "text"; text: string }> };
    type RichActorMessage = ActorMessage<AppDataContent>;

    const textOnlyUser = { type: "user", text: "hello" } satisfies RichActorMessage;
    const textOnlyAssistant = { type: "assistant", text: "hi" } satisfies RichActorMessage;
    const structuredPart = {
      type: "data",
      data: { answer: "42" },
    } satisfies ContentPart<AppDataContent>;

    expect(isActorMessage(textOnlyUser)).toBe(true);
    expect(isActorMessage(textOnlyAssistant)).toBe(true);
    expect(structuredPart.data).toEqual({ answer: "42" });
  });

  it("anchors data content types at charter and validates node output against data content", () => {
    type AppDataContent = { answer: string };
    const schema = z.object({ answer: z.string() });
    const appNode = createNode<AppDataContent>({
      key: "typed",
      output: {
        schema,
        mapTextBlock: (text) => ({ answer: text }),
      },
    });

    const appCharter = createCharter<AppDataContent>({
      executor: executor as Charter<AppDataContent>["executor"],
      nodes: [appNode],
      tools: [],
      commands: [],
      states: [],
      projections: [],
    });

    expectTypeOf(appCharter).toMatchTypeOf<Charter<AppDataContent>>();

    createNode<AppDataContent>({
      key: "badOutput",
      output: {
        // @ts-expect-error output.schema must parse the configured data content.
        schema: z.string(),
      },
    });

    const stringOutputNode = createNode<string>({
      key: "stringOutput",
      output: { schema: z.string() },
    });
    createCharter<AppDataContent>({
      executor: executor as Charter<AppDataContent>["executor"],
      nodes: [
        // @ts-expect-error registered nodes must use the charter data content type.
        stringOutputNode,
      ],
      tools: [],
      commands: [],
      states: [],
      projections: [],
    });
  });

  it("types compiled inference history as all frame messages", () => {
    type AppDataContent = { answer: string };
    const workMessage = {
      type: "work",
      kind: "completion",
      activationId: "activation-1",
      reason: "done",
    } satisfies Extract<CompiledInference<AppDataContent>["history"][number], { type: "work" }>;

    expect(workMessage.type).toBe("work");
  });
});

describe("node normalization", () => {
  it("applies node, runtime, state, and member defaults", () => {
    const state = { key: "memory", schema: z.object({ count: z.number() }), init: { count: 0 } };
    const member = createNode({ key: "member" });
    const node = createNode({
      key: "root",
      state,
      members: [member],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });

    expect(node.projection).toEqual({
      mode: "augment",
      instructions: "system",
      tools: "provider-static",
    });
    expect(node.runtime).toMatchObject({
      type: "generator",
      concurrency: "serial",
      activationHistory: "live",
      boundaryProjection: { mode: "hidden" },
    });
    expect(node.state).toMatchObject({
      key: "memory",
      scope: "hoist",
      onInitConflict: "replace",
      projection: "hidden",
    });
    expect(node.members).toEqual([member]);
  });

  it("rejects duplicate member keys", () => {
    const a = createNode({ key: "a" });
    const b = createNode({ key: "a" });

    expect(() => createNode({ key: "root", members: [a, b] })).toThrow(/Duplicate member key/);
    expect(() => createNode({ key: "root", members: [a, a] })).toThrow(/Duplicate member key/);
  });
});

describe("action state requirements", () => {
  it("types action contexts from the explicit action state descriptor", () => {
    const counterState = {
      key: "counter",
      schema: z.object({ count: z.number() }),
      init: { count: 0 },
    };
    const setCounter = createAction({
      state: counterState,
      name: "setCounter",
      inputSchema: z.object({ value: z.number() }),
      run: (input, ctx) => {
        expectTypeOf(input).toEqualTypeOf<{ value: number }>();
        expectTypeOf(ctx.state).toEqualTypeOf<{ count: number } | undefined>();
        ctx.updateState?.(patchState({ count: input.value }));
        ctx.updateState?.(replaceState({ count: input.value }));

        if (false) {
          // @ts-expect-error patch keys come from the action state descriptor
          ctx.updateState?.(patchState({ missing: true }));
          // @ts-expect-error replacement must match the action state descriptor
          ctx.updateState?.(replaceState({ missing: true }));
        }
      },
    });

    const node = createNode({ key: "counter", state: counterState, commands: [setCounter] });
    expect(node.commandBindings.setCounter).toBe(setCounter);
  });

  it("rejects stateful actions on missing or mismatched owner state", () => {
    const counterState = {
      key: "counter",
      schema: z.object({ count: z.number() }),
      init: { count: 0 },
    };
    const profileState = {
      key: "profile",
      schema: z.object({ name: z.string() }),
      init: { name: "Ada" },
    };
    const setCounter = createAction({
      state: counterState,
      name: "setCounter",
      run: () => undefined,
    });

    expect(() =>
      createMachine({
        root: { id: "r", isSource: true, node: createNode({ key: "missing-state", commands: [setCounter] }) },
        charter: charter(),
      }),
    ).toThrow(/requires state "counter" but the node has no state/);

    expect(() =>
      createMachine({
        root: {
          id: "r",
          isSource: true,
          node: createNode({ key: "profile", state: profileState, commands: [setCounter] }),
        },
        charter: charter(),
      }),
    ).toThrow(/requires state "counter" but the node owns state "profile"/);
  });

  it("rejects matching state keys with different schema objects", () => {
    const actionState = {
      key: "counter",
      schema: z.object({ count: z.number() }),
      init: { count: 0 },
    };
    const ownerState = {
      key: "counter",
      schema: z.object({ count: z.number() }),
      init: { count: 0 },
    };
    const readCounter = createAction({
      state: actionState,
      name: "readCounter",
    });
    const node = createNode({ key: "counter", state: ownerState, tools: [readCounter] });

    expect(() => compileProjection({ id: "r", isSource: true, node })).toThrow(
      /requires a different schema for state "counter"/,
    );
  });
});

describe("projection traversal", () => {
  it("traverses root instances, required members, and runtime children in pre-order", () => {
    const critic = createNode({ key: "critic" });
    const childA = createNode({ key: "childA" });
    const childB = createNode({ key: "childB" });
    const rootA = createNode({ key: "rootA", members: [critic] });
    const rootB = createNode({ key: "rootB" });
    const root = createRoot([
      {
        id: "a",
        node: rootA,
        children: [
          { id: "foo", isSource: true, node: childA },
          { id: "bar", isSource: true, node: childB },
        ],
      },
      { id: "b", isSource: true, node: rootB },
    ]);

    expect(collectProjectionNodes(root).map((frame) => frame.node.key)).toEqual([
      "root",
      "rootA",
      "critic",
      "childA",
      "childB",
      "rootB",
    ]);
    expect(collectProjectionNodes(root)[1]?.parent?.runtimeInstanceId).toBe(ROOT_RUNTIME_INSTANCE_ID);
  });

  it("rejects duplicate instance ids without reserving root globally", () => {
    const node = createNode({ key: "node" });

    expect(() => createRoot([{ id: "root", node }])).toThrow(/Duplicate instance id "root"/);
    expect(() => createMachine({
      root: { id: "root", isSource: true, node },
      charter: charter(),
    })).not.toThrow();
    expect(() => createMachine({
      root: { id: "custom", isSource: true, node },
      charter: charter(),
    })).not.toThrow();
    expect(() => createMachine({
      root: {
        id: "custom",
        isSource: true,
        node,
        children: [{ id: "custom", node }],
      },
      charter: charter(),
    })).toThrow(/Duplicate instance id "custom"/);
  });

  it("uses stable virtual member addresses and does not materialize members", () => {
    const leaf = createNode({ key: "retriever" });
    const research = createNode({ key: "research", members: [leaf] });
    const critic = createNode({ key: "critic" });
    const first = createNode({
      key: "root",
      members: [critic, research],
    });
    const second = createNode({
      key: "root2",
      members: [research, critic],
    });

    const instanceA: Instance = { id: "abc", isSource: true, node: first };
    const instanceB: Instance = { id: "abc", isSource: true, node: second };

    expect(collectProjectionNodes(instanceA).map((frame) => frame.runtimeInstanceId)).toContain(
      "member:abc/research/retriever",
    );
    expect(collectProjectionNodes(instanceB).map((frame) => frame.runtimeInstanceId)).toContain(
      "member:abc/research/retriever",
    );
    expect(instanceA.children).toBeUndefined();
  });
});

describe("projection compilation", () => {
  it("supports augment, replace, hidden, ordering, dynamic instructions, and tool order", () => {
    const firstTool: Action = { state: null, name: "dup" };
    const secondTool: Action = { state: null, name: "dup" };
    const hidden = createNode({
      key: "hidden",
      instructions: "hidden",
      tools: [{ state: null, name: "hiddenTool" }],
      projection: { mode: "hidden" },
    });
    const first = createNode({
      key: "first",
      instructions: "first",
      tools: [firstTool],
    });
    const replace = createNode({
      key: "replace",
      instructions: "replace",
      tools: [secondTool],
      projection: { mode: "replace", instructions: "dynamic" },
      members: [hidden, createNode({ key: "replaceChild", instructions: "replace child" })],
    });
    const root = createNode({ key: "root", instructions: "root", members: [first, replace] });

    const compiled = compileProjection(
      { id: "i", isSource: true, node: root },
      { history: [{ ...textUserMessage("kept") }] },
    );

    expect(compiled.systemParts).toEqual(textParts("replace child"));
    expect(compiled.dynamicParts).toEqual(textParts("replace"));
    expect(compiled.history).toEqual([{ ...textUserMessage("kept") }]);
    expect(compiled.tools.map((tool) => tool.name)).toEqual(["dup"]);
  });

  it("lets projection functions mutate the projection draft", () => {
    let callSite: string | undefined;
    let runtimeInstanceId: string | undefined;
    const hiddenTool: Action = { state: null, name: "hiddenTool" };
    const projectSensor = createProjectionFunction({
      name: "projectSensor",
      method: (ctx, draft, source) => {
        callSite = ctx.callSite;
        runtimeInstanceId = ctx.runtimeInstanceId;
        applyStaticProjection(draft, source, { tools: "hidden" });
        draft.dynamicParts.push({
          type: "text",
          text: "Camera sees: a red marker",
        });
      },
    });
    const sensor = createNode({
      key: "sensor",
      instructions: "base",
      tools: [hiddenTool],
      projection: projectSensor,
    });

    const compiled = compileProjection({ id: "sensor-instance", isSource: true, node: sensor });

    expect(callSite).toBe("node");
    expect(runtimeInstanceId).toBe("instance:sensor-instance");
    expect(compiled.systemParts).toEqual(textParts("base"));
    expect(compiled.dynamicParts).toEqual(textParts("Camera sees: a red marker"));
    expect(compiled.tools).toEqual([]);
  });

  it("rejects static boundaryProjection instructions and tools", () => {
    expect(() =>
      createNode({
        key: "generator",
        runtime: {
          type: "generator",
          trigger: { type: "spawn" },
          boundaryProjection: { mode: "augment", instructions: "dynamic" } as any,
        },
      }),
    ).toThrow(/only supports "mode"/);

    expect(() =>
      hydrateNode(
        {
          key: "generator",
          runtime: {
            type: "generator",
            trigger: { type: "spawn" },
            boundaryProjection: { mode: "augment", tools: "hidden" },
          },
        } as any,
        charter(),
      ),
    ).toThrow(/only supports "mode"/);
  });

  it("hides runtime boundaries by default and exports static boundaryProjection aggregates as compiled", () => {
    const inside = createNode({ key: "inside", instructions: "inside" });
    const generator = createNode({
      key: "generator",
      instructions: "generator",
      members: [inside],
      runtime: {
        type: "generator",
        trigger: { type: "spawn" },
        boundaryProjection: { mode: "augment" },
      },
    });
    const hiddenWorker = createNode({
      key: "hiddenWorker",
      instructions: "hiddenWorker",
      runtime: { type: "generator", trigger: { type: "spawn" } },
    });
    const root = createNode({
      key: "root",
      instructions: "root",
      members: [hiddenWorker, generator],
    });

    const parent = compileProjection({ id: "r", isSource: true, node: root });
    expect(parent.systemParts).toEqual(textParts("root", "generator", "inside"));
    expect(parent.dynamicParts).toEqual([]);
    expect(parent.systemParts).not.toContainEqual({ type: "text", text: "hiddenWorker" });

    const own = compileProjection(
      { id: "r", isSource: true, node: root },
      {
        targetGenerator: {
          id: "member:r/generator",
          kind: "generator",
          runtimeInstanceId: "member:r/generator",
        },
      },
    );
    expect(own.systemParts).toEqual(textParts("generator", "inside"));
  });

  it("lets boundaryProjection replace clear previous parent sections", () => {
    const generator = createNode({
      key: "generator",
      instructions: "generator",
      runtime: {
        type: "generator",
        trigger: { type: "spawn" },
        boundaryProjection: { mode: "replace" },
      },
    });
    const root = createNode({ key: "root", instructions: "root", members: [generator] });

    expect(compileProjection({ id: "r", isSource: true, node: root }).systemParts).toEqual(textParts("generator"));
  });

  it("inspects nested runtime boundaries and their compiled projection payloads", () => {
    const inside = createNode({ key: "inside", instructions: "inside" });
    const generator = createNode({
      key: "generator",
      instructions: "generator",
      members: [inside],
      runtime: {
        type: "generator",
        trigger: { type: "spawn" },
        boundaryProjection: { mode: "augment" },
      },
    });
    const root = createNode({
      key: "root",
      instructions: "root",
      members: [generator],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });

    const tree = inspectCompiledProjectionTree({ id: "r", isSource: true, node: root });
    const rootProjection = tree.roots[0];
    const generatorProjection = rootProjection?.children[0];

    expect(rootProjection?.nodeKey).toBe("root");
    expect(rootProjection?.compiled.systemParts).toEqual(textParts("root", "generator", "inside"));
    expect(rootProjection?.compiled.dynamicParts).toEqual([]);
    expect(rootProjection?.projectionNodes.map((projectionNode) => projectionNode.nodeKey)).toEqual(["root"]);
    expect(generatorProjection?.nodeKey).toBe("generator");
    expect(generatorProjection?.kind).toBe("generator");
    expect(generatorProjection?.compiled.systemParts).toEqual(textParts("generator", "inside"));
    expect(generatorProjection?.projectionNodes.map((projectionNode) => projectionNode.nodeKey)).toEqual([
      "generator",
      "inside",
    ]);
    expect(generatorProjection?.parentRuntimeInstanceId).toBe("instance:r");
  });

  it("includes hidden runtime boundaries in inspection without exporting their parent payload", () => {
    const hiddenWorker = createNode({
      key: "hiddenWorker",
      instructions: "hiddenWorker",
      runtime: { type: "generator", trigger: { type: "spawn" } },
    });
    const root = createNode({
      key: "root",
      instructions: "root",
      members: [hiddenWorker],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });

    const tree = inspectCompiledProjectionTree({ id: "r", isSource: true, node: root });

    expect(tree.roots[0]?.children[0]?.nodeKey).toBe("hiddenWorker");
    expect(tree.roots[0]?.compiled.systemParts).toEqual(textParts("root"));
    expect(tree.roots[0]?.compiled.systemParts).not.toContainEqual({ type: "text", text: "hiddenWorker" });
  });

  it("inspects replace projection output after previous sections are cleared", () => {
    const generator = createNode({
      key: "generator",
      instructions: "generator",
      runtime: {
        type: "generator",
        trigger: { type: "spawn" },
        boundaryProjection: { mode: "replace" },
      },
    });
    const root = createNode({
      key: "root",
      instructions: "root",
      members: [generator],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });

    const tree = inspectCompiledProjectionTree({ id: "r", isSource: true, node: root });

    expect(tree.roots[0]?.compiled.systemParts).toEqual(textParts("generator"));
    expect(tree.roots[0]?.projection.own.mode).toBe("augment");
    expect(tree.roots[0]?.children[0]?.projection.boundary.mode).toBe("replace");
  });

  it("compiles nested target generators from their own runtime boundary", () => {
    const tool: Action = { state: null, name: "save" };
    const generator = createNode({
      key: "generator",
      instructions: "generator",
      tools: [tool],
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const root = createNode({
      key: "root",
      instructions: "root",
      members: [generator],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });

    const compiled = compileProjection(
      { id: "r", isSource: true, node: root },
      { targetGenerator: makeGenerator("member:r/generator", "generator") },
    );

    expect(compiled.systemParts).toEqual(textParts("generator"));
    expect(compiled.tools.map((entry) => entry.name)).toEqual(["save"]);
  });

  it("preserves the supplied target generator identity in projection context", () => {
    const seenTargets: string[] = [];
    const captureTarget = createProjectionFunction({
      name: "captureTarget",
      method: (ctx, draft, source) => {
        seenTargets.push(ctx.target?.id ?? "");
        applyStaticProjection(draft, source);
      },
    });
    const generator = createNode({
      key: "generator",
      projection: captureTarget,
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const root = createNode({
      key: "root",
      members: [generator],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });

    compileProjection(
      { id: "r", isSource: true, node: root },
      {
        targetGenerator: {
          id: "generator:activation-specific",
          kind: "generator",
          runtimeInstanceId: "member:r/generator",
        },
      },
    );

    expect(seenTargets).toEqual(["generator:activation-specific"]);
  });

  it("projects fully compiled child generators through their boundaryProjection", () => {
    const leaf = createNode({
      key: "leaf",
      instructions: "leaf",
      runtime: {
        type: "generator",
        trigger: { type: "parent-completion" },
        boundaryProjection: { mode: "augment" },
      },
    });
    const generator = createNode({
      key: "generator",
      instructions: "generator",
      members: [leaf],
      runtime: {
        type: "generator",
        trigger: { type: "spawn" },
        boundaryProjection: { mode: "augment" },
      },
    });
    const root = createNode({ key: "root", instructions: "root", members: [generator] });

    const compiled = compileProjection({ id: "r", isSource: true, node: root });

    expect(compiled.systemParts).toEqual(textParts("root", "generator", "leaf"));
    expect(compiled.dynamicParts).toEqual([]);
  });
});

describe("state resolution and state projection", () => {
  it("initializes local state on the owner and hoist state on a direct root", () => {
    const local = createNode({
      key: "local",
      state: { key: "local", scope: "local", schema: z.number(), init: 1 },
    });
    const hoist = createNode({
      key: "hoist",
      state: { key: "hoist", scope: "hoist", schema: z.number(), init: 2 },
    });
    const root = createNode({ key: "root", members: [local], state: undefined });
    const childRoot = createNode({ key: "childRoot", members: [hoist] });
    const instance: Instance = {
      id: "root",
      node: root,
      children: [{ id: "child", isSource: true, node: childRoot }],
    };

    resolveStates(instance);

    expect(instance.states?.local?.value).toBe(1);
    expect(instance.states?.hoist).toBeUndefined();
    expect(instance.children?.[0]?.states?.hoist?.value).toBe(2);
  });

  it("skips the non-source createRoot wrapper for hoist state ownership", () => {
    const memory = createNode({
      key: "memory",
      state: { key: "hoist", scope: "hoist", schema: z.number(), init: 2 },
    });
    const app = createNode({ key: "app", members: [memory] });
    const root = createRoot([{ id: "app", isSource: true, node: app }]);

    resolveStates(root);

    expect(root.states).toBeUndefined();
    expect(root.children?.[0]?.states?.hoist?.value).toBe(2);
  });

  it("shares compatible state keys and applies latest projection policy", () => {
    const stateA = {
      key: "shared",
      schema: z.object({ value: z.number() }),
      init: { value: 1 },
      projection: "system" as const,
    };
    const stateB = {
      key: "shared",
      schema: z.object({ value: z.number() }),
      init: { value: 1 },
      projection: "dynamic" as const,
    };
    const a = createNode({ key: "a", state: stateA });
    const b = createNode({ key: "b", state: stateB });
    const root = createNode({ key: "root", members: [a, b] });
    const instance: Instance = { id: "r", isSource: true, node: root };

    const states = resolveStates(instance);
    expect(states).toHaveLength(1);
    expect(states[0]?.descriptor.projection).toBe("dynamic");
    expect(compileProjection(instance).dynamicParts).toEqual(textParts('State `shared`: {"value":1}'));
  });

  it("detects incompatible descriptors and init conflicts", () => {
    const local = createNode({
      key: "local",
      state: { key: "x", scope: "local", schema: z.number(), init: 1 },
    });
    const hoist = createNode({
      key: "hoist",
      state: { key: "x", scope: "hoist", schema: z.number(), init: 1 },
    });
    expect(() => resolveStates({ id: "r", isSource: true, node: createNode({ key: "root", members: [local, hoist] }) }))
      .toThrow(/scopes differ/);

    const number = createNode({
      key: "number",
      state: { key: "x", schema: z.number(), init: 1 },
    });
    const string = createNode({
      key: "string",
      state: { key: "x", schema: z.string(), init: "1" },
    });
    expect(() =>
      resolveStates({ id: "r", isSource: true, node: createNode({ key: "root", members: [number, string] }) }),
    ).toThrow(/Conflicting init|schema validation/);

    const one = createNode({ key: "one", state: { key: "x", schema: z.number(), init: 1 } });
    const two = createNode({ key: "two", state: { key: "x", schema: z.number(), init: 2 } });
    expect(() =>
      resolveStates({ id: "r", isSource: true, node: createNode({ key: "root", members: [one, two] }) }),
    ).toThrow(/Conflicting init/);
  });

  it("accepts equivalent JSON init and same init function but rejects different functions", () => {
    const init = () => 1;
    const jsonA = createNode({
      key: "jsonA",
      state: { key: "x", schema: z.object({ a: z.number(), b: z.number() }), init: { a: 1, b: 2 } },
    });
    const jsonB = createNode({
      key: "jsonB",
      state: { key: "x", schema: z.object({ a: z.number(), b: z.number() }), init: { b: 2, a: 1 } },
    });
    expect(() =>
      resolveStates({ id: "r", isSource: true, node: createNode({ key: "root", members: [jsonA, jsonB] }) }),
    ).not.toThrow();

    const fnA = createNode({ key: "fnA", state: { key: "x", schema: z.number(), init } });
    const fnB = createNode({ key: "fnB", state: { key: "x", schema: z.number(), init } });
    expect(() =>
      resolveStates({ id: "r", isSource: true, node: createNode({ key: "root", members: [fnA, fnB] }) }),
    ).not.toThrow();

    const fnC = createNode({ key: "fnC", state: { key: "x", schema: z.number(), init: () => 1 } });
    expect(() =>
      resolveStates({ id: "r", isSource: true, node: createNode({ key: "root", members: [fnA, fnC] }) }),
    ).toThrow(/Conflicting init/);
  });

  it("replaces or rejects invalid existing state according to the strictest policy", () => {
    const replacing = createNode({
      key: "replace",
      state: { key: "x", schema: z.number(), init: 1, onInitConflict: "replace" },
    });
    const replaceInstance: Instance = {
      id: "r",
      isSource: true,
      node: replacing,
      states: { x: { value: "bad" } },
    };
    resolveStates(replaceInstance);
    expect(replaceInstance.states?.x?.value).toBe(1);

    const erroring = createNode({
      key: "error",
      state: { key: "x", schema: z.number(), init: 1, onInitConflict: "error" },
    });
    expect(() =>
      resolveStates({ id: "r", isSource: true, node: erroring, states: { x: { value: "bad" } } }),
    ).toThrow(/invalid/);
  });
});

describe("retrieval aliases", () => {
  it("uses bare unique keys and instance-qualified duplicate keys", () => {
    const state = (key: string) =>
      createNode({
        key: `${key}Node`,
        state: { key, schema: z.number(), init: 1, projection: "retrieval", scope: "local" },
      });
    const root = createRoot([
      { id: "a", isSource: true, node: state("shared") },
      { id: "b", isSource: true, node: state("shared") },
      { id: "c", isSource: true, node: state("unique") },
    ]);
    const compiled = compileProjection(root);

    expect(compiled.retrievableStates.map((entry) => entry.address)).toEqual([
      "shared:a",
      "shared:b",
      "unique",
    ]);
    expect(compiled.tools.map((tool) => tool.name)).toEqual(["getState"]);
  });

  it("keeps the getState tool schema stable across projected state aliases", () => {
    const state = (nodeKey: string, stateKey: string) =>
      createNode({
        key: nodeKey,
        state: { key: stateKey, schema: z.number(), init: 1, projection: "retrieval", scope: "local" },
      });
    const unique = compileProjection({ id: "one", isSource: true, node: state("one", "memory") });
    const duplicate = compileProjection(
      createRoot([
        { id: "a", isSource: true, node: state("a", "memory") },
        { id: "b", isSource: true, node: state("b", "memory") },
      ]),
    );
    const uniqueSchema = getStateJsonSchema(unique);
    const duplicateSchema = getStateJsonSchema(duplicate);

    expect(uniqueSchema).toEqual(duplicateSchema);
    expect(JSON.stringify(uniqueSchema)).toContain('"type":"string"');
    expect(JSON.stringify(uniqueSchema)).not.toContain('"enum"');
  });

  it("throws generated alias collisions", () => {
    const retrieval = (nodeKey: string, stateKey: string) =>
      createNode({
        key: nodeKey,
        state: { key: stateKey, schema: z.number(), init: 1, projection: "retrieval", scope: "local" },
      });
    const root = createRoot([
      { id: "x", isSource: true, node: retrieval("a", "a") },
      { id: "y", isSource: true, node: retrieval("b", "a") },
      { id: "z", isSource: true, node: retrieval("collision", "a:x") },
    ]);

    expect(() => compileProjection(root)).toThrow(/alias collision/);
  });

  it("reserves the getState tool name when retrieval state is projected", () => {
    const root = createNode({
      key: "root",
      tools: [{ state: null, name: "getState" }],
      state: { key: "memory", schema: z.number(), init: 1, projection: "retrieval" },
    });

    expect(() => compileProjection({ id: "r", isSource: true, node: root })).toThrow(/reserved for state retrieval/);
  });

  it("omits retrieval aliases and notes when tools are hidden", () => {
    const retriever = createNode({
      key: "retriever",
      state: { key: "secret", schema: z.number(), init: 1, projection: "retrieval" },
      projection: { tools: "hidden" },
    });

    const compiled = compileProjection({ id: "r", isSource: true, node: retriever });
    expect(compiled.retrievableStates).toEqual([]);
    expect(compiled.systemParts).toEqual([]);

    const omitRetrievalBoundary = createProjectionFunction({
      name: "omitRetrievalBoundary",
      method: (_ctx, draft, source) => {
        const promptParts = [...source.systemParts, ...source.dynamicParts].filter(
          (part) => !(part.type === "state" && part.section === "retrieval"),
        );
        draft.systemParts.push(...promptParts);
      },
    });
    const boundary = createNode({
      key: "boundary",
      state: { key: "hidden", schema: z.number(), init: 2, projection: "retrieval", scope: "local" },
      runtime: {
        type: "generator",
        trigger: { type: "spawn" },
        boundaryProjection: omitRetrievalBoundary,
      },
    });
    const root = createNode({ key: "root", members: [boundary] });

    const parentCompiled = compileProjection({ id: "parent", isSource: true, node: root });
    expect(parentCompiled.retrievableStates).toEqual([]);
    expect(parentCompiled.systemParts).toEqual([]);
  });

  it("projects hoist-scoped generator member state from the owner while hiding generator tools", () => {
    const generatorTool = createAction({ state: null, name: "generatorTool" });
    const generator = createNode({
      key: "generator",
      state: {
        key: "memories",
        schema: z.array(z.object({ text: z.string() })),
        init: [],
        projection: "dynamic",
      },
      tools: [generatorTool],
      runtime: {
        type: "generator",
        trigger: { type: "parent-completion" },
      },
    });
    const root = createNode({
      key: "root",
      members: [generator],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });

    const compiled = compileProjection(
      { id: "r", isSource: true, node: root },
      { targetGenerator: makeGenerator("instance:r", "generator") },
    );

    expect(compiled.dynamicParts).toContainEqual({ type: "text", text: "State `memories`: []" });
    expect(compiled.tools).toEqual([]);
  });
});

describe("history projection", () => {
  it("uses full message history projection by default for target generators", () => {
    const generator = createNode({
      key: "generator",
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const root = createNode({ key: "root", members: [generator] });
    const instance: Instance = { id: "r", isSource: true, node: root };

    const compiled = compileProjection(instance, {
      targetGenerator: makeGenerator("member:r/generator", "generator"),
      frameHistory: [
        frame("one", [{ ...textUserMessage("hello") }]),
        frame("two", [
          {
            type: "instance",
            kind: "state.update",
            instanceId: "r",
            stateKey: "status",
            update: { op: "replace", value: "ready" },
          },
        ]),
        frame("three", [{ ...textAssistantMessage("hi"), audience: "broadcast" }]),
      ],
    });

    expect(compiled.history).toEqual([
      { ...textUserMessage("hello") },
      {
        type: "instance",
        kind: "state.update",
        instanceId: "r",
        stateKey: "status",
        update: { op: "replace", value: "ready" },
      },
      { ...textAssistantMessage("hi"), audience: "broadcast" },
    ]);
  });

  it("lets runtime history projection return synthetic messages from frames and state", () => {
    const projection = createHistoryProjectionFunction({
      name: "syntheticHistory",
      method: (ctx) => {
        const text = JSON.stringify({
          messages: actorMessages(ctx),
          state: ctx.states.memory,
          trigger: ctx.trigger.type,
        });
        return [textUserMessage(text)];
      },
    });
    const generator = createNode({
      key: "generator",
      state: {
        key: "memory",
        schema: z.object({ memories: z.array(z.string()) }),
        init: { memories: ["existing"] },
      },
      runtime: {
        type: "generator",
        trigger: { type: "parent-completion" },
        historyProjection: projection,
      },
    });
    const root = createNode({ key: "root", members: [generator] });
    const instance: Instance = { id: "r", isSource: true, node: root };

    const compiled = compileProjection(instance, {
      targetGenerator: makeGenerator("member:r/generator", "generator"),
      frameHistory: [frame("one", [{ ...textUserMessage("remember tea") }])],
    });

    expect(compiled.history).toEqual([
      textUserMessage(
        JSON.stringify({
          messages: [{ ...textUserMessage("remember tea") }],
          state: { memories: ["existing"] },
          trigger: "parent-completion",
        }),
      ),
    ]);
  });

  it("qualifies duplicate state keys in history projection state values", () => {
    const projection = createHistoryProjectionFunction({
      name: "stateHistory",
      method: (ctx) => [textUserMessage(JSON.stringify(ctx.states))],
    });
    const node = createNode({
      key: "agent",
      state: { key: "shared", schema: z.number(), init: 1, scope: "local" },
      runtime: {
        type: "generator",
        trigger: { type: "actor-frame" },
        historyProjection: projection,
      },
    });

    const compiled = compileProjection(
      createRoot([
        { id: "a", node },
        { id: "b", node },
      ]),
      {
        targetGenerator: makeGenerator("instance:a", "generator"),
        frameHistory: [],
      },
    );

    expect(compiled.history).toEqual([
      textUserMessage(JSON.stringify({ "shared:a": 1, "shared:b": 1 })),
    ]);
  });

  it("projects messages before and since the target runtime's last completion", () => {
    const ctx = {
      target: makeGenerator("member:r/memory", "generator"),
      runtimeInstanceId: "member:r/memory",
      activationId: "activation-2",
      trigger: { type: "parent-completion" as const },
      states: {},
      history: [
        frame("before", [{ ...textUserMessage("old") }]),
        {
          id: "completion",
          ...createRuntimeCompletionFrame({
            generatorId: "member:r/memory",
            runtimeInstanceId: "member:r/memory",
            activationId: "activation-1",
            completionReason: "done",
          }),
        },
        frame("after", [{ ...textUserMessage("new") }]),
        frame("other", [{ ...textAssistantMessage("answer") }]),
      ],
    };

    expect(messagesBeforeLastCompletion(ctx)).toEqual([{ ...textUserMessage("old") }]);
    expect(messagesSinceLastCompletion(ctx)).toEqual([
      { ...textUserMessage("new") },
      { ...textAssistantMessage("answer") },
    ]);
  });

  it("serializes registered history projection functions by ref", () => {
    const historyProjection = createHistoryProjectionFunction({
      name: "memory",
      method: () => [],
    });
    const registry = charter({ historyProjections: [historyProjection] });

    expect(serializeHistoryProjection({ type: "messages" }, registry)).toEqual({ type: "messages" });
    expect(hydrateHistoryProjection({ type: "messages" }, registry)).toEqual({ type: "messages" });
    expect(serializeHistoryProjection({ type: "actor" }, registry)).toEqual({ type: "actor" });
    expect(hydrateHistoryProjection({ type: "actor" }, registry)).toEqual({ type: "actor" });
    expect(serializeHistoryProjection(historyProjection, registry)).toBe("memory");
    expect(hydrateHistoryProjection("memory", registry)).toBe(historyProjection);
    expect(() =>
      serializeHistoryProjection(
        createHistoryProjectionFunction({ name: "missing", method: () => [] }),
        registry,
      )
    ).toThrow(
      /unregistered history projection/,
    );
  });

  it("filters durable history by audience, delivery, and snapshot activation policy", () => {
    const generator = createNode({
      key: "generator",
      runtime: {
        type: "generator",
        trigger: { type: "parent-completion" },
        activationHistory: "snapshot",
      },
    });
    const root = createNode({ key: "root", members: [generator] });
    const runtimeInstanceId = "member:r/generator";
    const activationId = "activation-1";

    const compiled = compileProjection(
      { id: "r", isSource: true, node: root },
      {
        targetGenerator: makeGenerator(runtimeInstanceId, "generator"),
        activationId,
        frameHistory: [
          frame("before", [{ ...textUserMessage("queued before"), delivery: "queued" }]),
          frame("self-other", [{ ...textAssistantMessage("hidden self") }]),
          {
            id: "activation",
            ...createActivationFrame({
              activationId,
              runtimeInstanceId,
              generatorId: runtimeInstanceId,
              sourceFrameId: "before",
              concurrencyKey: runtimeInstanceId,
              concurrency: "serial",
            }),
          },
          frame("after", [{ ...textUserMessage("hidden by snapshot") }]),
          frame("queued-after", [
            { ...textUserMessage("hidden queued"), delivery: "queued" },
          ]),
          {
            id: "same-activation",
            generatorId: runtimeInstanceId,
            runtimeInstanceId,
            activationId,
            messages: [{ ...textAssistantMessage("same activation") }],
          },
        ],
      },
    );

    expect(compiled.history).toEqual([
      { ...textUserMessage("queued before"), delivery: "queued" },
      {
        type: "work",
        kind: "activation",
        activationId,
        runtimeInstanceId,
        generatorId: runtimeInstanceId,
        sourceFrameId: "before",
        concurrencyKey: runtimeInstanceId,
        concurrency: "serial",
      },
      { ...textAssistantMessage("same activation") },
    ]);
  });
});

describe("commands and instance mutations", () => {
  it("executes commands once with bound state helpers and durable state keys", async () => {
    const counterState = {
      key: "counter",
      schema: z.object({ count: z.number() }),
      init: { count: 0 },
    };
    const setCounter = createAction({
      state: counterState,
      name: "setCounter",
      inputSchema: z.object({ value: z.number() }),
      run: (input, ctx) => {
        expect(ctx.state).toEqual({ count: 0 });
        ctx.updateState?.(patchState({ count: 1 }));
        expect(ctx.state).toEqual({ count: 1 });
        ctx.updateState?.(replaceState({ count: input.value }));
        expect(ctx.state).toEqual({ count: 4 });
        return { ...textAssistantMessage("updated"), audience: "broadcast" };
      },
    });
    const controls = createNode({
      key: "controls",
      state: counterState,
      commands: [setCounter],
    });
    const root = createNode({ key: "root", members: [controls] });
    const instance: Instance = { id: "r", isSource: true, node: root };
    const machine = createMachine({
      root: instance,
      charter: charter(),
    });

    await expect(
      executeCommand(machine, {
        type: "command",
        name: "setCounter",
        input: { value: 4 },
        target: { type: "member", ownerInstanceId: "r", memberPath: ["controls"] },
        clientId: "client-1",
      }),
    ).resolves.toEqual({
      success: true,
      value: { ...textAssistantMessage("updated"), audience: "broadcast" },
      clientId: "client-1",
    });

    expect(instance.states?.counter?.value).toEqual({ count: 4 });
    expect(machine.frames.map((item) => item.messages[0])).toMatchObject([
      { type: "command", name: "setCounter", clientId: "client-1" },
      { type: "instance", kind: "state.update", instanceId: "r", stateKey: "counter" },
      { type: "instance", kind: "state.update", instanceId: "r", stateKey: "counter" },
      { ...textAssistantMessage("updated"), audience: "broadcast" },
    ]);
  });

  it("appends to array state through state update helpers", async () => {
    const logState = {
      key: "log",
      schema: z.array(z.string()),
      init: [] as string[],
    };
    const appendLog = createAction({
      state: logState,
      name: "appendLog",
      inputSchema: z.object({ value: z.string() }),
      run: ({ value }, ctx) => {
        ctx.updateState?.(appendState(value, "indexed"));
      },
    });
    const instance: Instance = {
      id: "r",
      isSource: true,
      node: createNode({
        key: "logger",
        state: logState,
        commands: [appendLog],
      }),
    };
    const machine = createMachine({
      root: instance,
      charter: charter(),
    });

    await executeCommand(machine, {
      type: "command",
      name: "appendLog",
      input: { value: "created" },
    });

    expect(instance.states?.log?.value).toEqual(["created", "indexed"]);
    expect(machine.frames[1]?.messages[0]).toMatchObject({
      type: "instance",
      kind: "state.update",
      instanceId: "r",
      stateKey: "log",
      update: { op: "append", values: ["created", "indexed"] },
    });
  });

  it("folds spawn messages and derives spawn-triggered runtime work", async () => {
    const generator = createNode({
      key: "generator",
      state: {
        key: "spawned",
        schema: z.object({ ready: z.boolean() }),
        init: { ready: false },
      },
      runtime: { type: "generator", trigger: { type: "spawn" } },
    });
    const root = createNode({ key: "root" });
    const instance: Instance = { id: "r", isSource: true, node: root };
    const machine = createMachine({
      id: "spawn-demo",
      root: instance,
      charter: charter({ nodes: [generator] }),
    });
    const spawnFrame = machine.enqueueFrame({
      messages: [
        {
          type: "instance",
          kind: "spawn",
          parentInstanceId: "r",
          children: [
            {
              id: "child",
              node: "generator",
              states: { spawned: { ready: true } },
            },
          ],
        },
      ],
    });

    const frames = await collectFrames(runMachine(machine, { scheduleWork: false }));
    const activation = frames.find((item) => item.messages[0]?.type === "work");

    expect(instance.children?.map((child) => child.id)).toEqual(["child"]);
    expect(instance.states?.spawned?.value).toEqual({ ready: true });
    expect(instance.children?.[0]?.states).toBeUndefined();
    expect(activation?.messages[0]).toMatchObject({
      type: "work",
      kind: "activation",
      runtimeInstanceId: "instance:child",
      generatorId: "instance:child",
      sourceFrameId: spawnFrame.id,
    });
  });

  it("lets member commands spawn children under their concrete owner", async () => {
    const child = createNode({ key: "child" });
    const spawnChild = createAction({
      state: null,
      name: "spawnChild",
      run: (_input, ctx) => {
        ctx.instance.spawn(child);
      },
    });
    const controls = createNode({ key: "controls", commands: [spawnChild] });
    const root = createNode({ key: "root", members: [controls] });
    const instance: Instance = { id: "r", isSource: true, node: root };
    const machine = createMachine({
      id: "member-spawn-demo",
      root: instance,
      charter: charter(),
    });

    await executeCommand(machine, {
      type: "command",
      name: "spawnChild",
      input: {},
      target: { type: "member", ownerInstanceId: "r", memberPath: ["controls"] },
    });

    expect(instance.children?.map((item) => item.node.key)).toEqual(["child"]);
    expect(machine.frames.at(-1)?.messages[0]).toMatchObject({
      type: "instance",
      kind: "spawn",
      parentInstanceId: "r",
      children: [{ node: { key: "child" } }],
    });
  });

  it("lets concrete commands spawn children under themselves", async () => {
    const child = createNode({ key: "child" });
    const spawnChild = createAction({
      state: null,
      name: "spawnChild",
      run: (_input, ctx) => {
        ctx.instance.spawn(child);
      },
    });
    const root = createNode({ key: "root", commands: [spawnChild] });
    const instance: Instance = { id: "r", isSource: true, node: root };
    const machine = createMachine({
      id: "concrete-spawn-demo",
      root: instance,
      charter: charter(),
    });

    await executeCommand(machine, {
      type: "command",
      name: "spawnChild",
      input: {},
    });

    expect(instance.children?.map((item) => item.node.key)).toEqual(["child"]);
    expect(machine.frames.at(-1)?.messages[0]).toMatchObject({
      type: "instance",
      kind: "spawn",
      parentInstanceId: "r",
    });
  });

  it("lets commands cede matching child nodes", async () => {
    const camera = createNode({ key: "camera" });
    const other = createNode({ key: "other" });
    const cedeCamera = createAction({
      state: null,
      name: "cedeCamera",
      run: (_input, ctx) => {
        ctx.instance.cede(camera);
      },
    });
    const controls = createNode({ key: "controls", commands: [cedeCamera] });
    const root = createNode({ key: "root", members: [controls] });
    const instance: Instance = {
      id: "r",
      node: root,
      children: [
        { id: "camera-1", isSource: true, node: camera },
        { id: "other-1", isSource: true, node: other },
      ],
    };
    const machine = createMachine({
      id: "cede-child-demo",
      root: instance,
      charter: charter(),
    });

    await executeCommand(machine, {
      type: "command",
      name: "cedeCamera",
      input: {},
      target: { type: "member", ownerInstanceId: "r", memberPath: ["controls"] },
    });

    expect(instance.children?.map((item) => item.id)).toEqual(["other-1"]);
    expect(machine.frames.at(-1)?.messages).toMatchObject([
      {
        type: "instance",
        kind: "remove",
        instanceId: "camera-1",
        reason: "cede",
      },
    ]);
  });

  it("lets commands transition their concrete owner", async () => {
    const next = createNode({ key: "next" });
    const transitionOwner = createAction({
      state: null,
      name: "transitionOwner",
      run: (_input, ctx) => {
        ctx.instance.transition(next);
      },
    });
    const controls = createNode({ key: "controls", commands: [transitionOwner] });
    const root = createNode({ key: "root", members: [controls] });
    const instance: Instance = { id: "r", isSource: true, node: root };
    const machine = createMachine({
      id: "transition-owner-demo",
      root: instance,
      charter: charter(),
    });

    await executeCommand(machine, {
      type: "command",
      name: "transitionOwner",
      input: {},
      target: { type: "member", ownerInstanceId: "r", memberPath: ["controls"] },
    });

    expect(instance.node.key).toBe("next");
    expect(machine.frames.at(-1)?.messages[0]).toMatchObject({
      type: "instance",
      kind: "transition",
      instanceId: "r",
      node: { key: "next" },
    });
  });

  it("folds dry inline spawn nodes with serialized refs", () => {
    const search: Action = { state: null, name: "search" };
    const generator = createNode({
      key: "generator",
      tools: [search],
    });
    const root = createNode({ key: "root" });
    const registry = charter({ tools: [search] });
    const serializedWorker = serializeNode(generator, registry);
    if (typeof serializedWorker === "string") {
      throw new Error("Expected an inline serialized generator");
    }

    const instance: Instance = { id: "r", isSource: true, node: root };
    const machine = createMachine({
      id: "dry-spawn-demo",
      root: instance,
      charter: registry,
    });

    machine.enqueueFrame({
      messages: [
        {
          type: "instance",
          kind: "spawn",
          parentInstanceId: "r",
          children: [{ id: "child", node: serializedWorker }],
        },
      ],
    });

    expect(instance.children?.[0]?.node.toolRefs).toEqual(["search"]);
    expect(machine.frames[0]?.messages[0]).toMatchObject({
      type: "instance",
      kind: "spawn",
      children: [{ node: { tools: ["search"] } }],
    });
  });

  it("preserves source node knowledge for inline action refs", () => {
    const search: Action = { state: null, name: "search", description: "source" };
    const source = createNode({ key: "source", tools: [search] });
    const inline = createNode({
      key: "inline",
      sourceNodeKey: "source",
      tools: [search],
    });
    const registry = charter({ nodes: [source] });
    const serialized = serializeNode(inline, registry);

    expect(serialized).toMatchObject({
      key: "inline",
      sourceNodeKey: "source",
      tools: ["search"],
    });
    const hydrated = hydrateNode(serialized, registry);
    const compiled = compileProjection({ id: "i", isSource: true, node: hydrated }, { charter: registry });
    expect(compiled.tools.map((tool) => tool.description)).toEqual(["source"]);
    expect(hydrated.toolBindings.search).toBe(search);
    expect(hydrated.toolRefs).toEqual(["search"]);
  });
});

describe("work scheduling", () => {
  it("yields activation and completion work frames in host-gated order", async () => {
    const calls: string[] = [];
    const runtimeExecutor = {
      run: async (request: ExecutorRunRequest) => {
        calls.push(request.runtimeInstanceId);
        return { completionReason: "done" as const };
      },
      realizePrompt: (request: { inference: unknown }) => ({ provider: "test", input: request.inference }),
    };
    const memory = createNode({
      key: "memory",
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const root = createNode({
      key: "root",
      members: [memory],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "demo",
      root: { id: "r", isSource: true, node: root },
      charter: charter({ executor: runtimeExecutor }),
    });
    const userFrame = machine.enqueueFrame({
      messages: [{ ...textUserMessage("remember my name") }],
    });

    const iterator = runMachine(machine)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: userFrame.id },
    });
    expect(calls).toEqual([]);

    const rootActivation = await iterator.next();
    const rootActivationMessage = rootActivation.value?.messages[0];
    expect(rootActivationMessage).toMatchObject({
      type: "work",
      kind: "activation",
      runtimeInstanceId: "instance:r",
      generatorId: "instance:r",
      sourceFrameId: userFrame.id,
      concurrencyKey: "instance:r",
      concurrency: "serial",
    });
    expect(calls).toEqual([]);

    const rootCompletion = await iterator.next();
    expect(calls).toEqual(["instance:r"]);
    expect(rootCompletion.value?.messages[0]).toMatchObject({
      type: "work",
      kind: "completion",
      activationId: (rootActivationMessage as { activationId: string }).activationId,
      sourceFrameId: userFrame.id,
      reason: "end-turn",
    });

    const memoryActivation = await iterator.next();
    const memoryActivationMessage = memoryActivation.value?.messages[0];
    expect(memoryActivationMessage).toMatchObject({
      type: "work",
      kind: "activation",
      runtimeInstanceId: "member:r/memory",
      generatorId: "member:r/memory",
      sourceFrameId: rootCompletion.value?.id,
      concurrencyKey: "member:r/memory",
    });
    expect(calls).toEqual(["instance:r"]);

    const memoryCompletion = await iterator.next();
    expect(calls).toEqual(["instance:r", "member:r/memory"]);
    expect(memoryCompletion.value?.messages[0]).toMatchObject({
      type: "work",
      kind: "completion",
      activationId: (memoryActivationMessage as { activationId: string }).activationId,
      sourceFrameId: rootCompletion.value?.id,
      reason: "done",
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("starts activation work after yielding the activation frame and gates follow-up work on queued frame yield", async () => {
    let releaseRoot!: () => void;
    const rootStep = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    });
    const calls: string[] = [];
    const runtimeExecutor = {
      run: async (request: ExecutorRunRequest) => {
        calls.push(request.runtimeInstanceId);
        if (request.runtimeInstanceId === "instance:r") {
          await rootStep;
        }
        return {
          completionReason: "done" as const,
          value: request.runtimeInstanceId,
        };
      },
      realizePrompt: (request: { inference: unknown }) => ({ provider: "test", input: request.inference }),
    };
    const memory = createNode({
      key: "memory",
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const root = createNode({
      key: "root",
      members: [memory],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "gated-demo",
      root: { id: "r", isSource: true, node: root },
      charter: charter({ executor: runtimeExecutor }),
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("go") }] });

    const iterator = runMachine(machine)[Symbol.asyncIterator]();
    await iterator.next();
    const activation = await iterator.next();

    expect(activation.value?.messages[0]).toMatchObject({
      type: "work",
      kind: "activation",
      runtimeInstanceId: "instance:r",
    });
    expect(calls).toEqual([]);

    const assistant = iterator.next();
    await flushPromises();
    expect(calls).toEqual(["instance:r"]);
    releaseRoot();
    await flushPromises();

    expect(machine.frames.map((frame) => frame.messages[0])).toMatchObject([
      { type: "user" },
      { type: "work", kind: "activation", runtimeInstanceId: "instance:r" },
      { type: "assistant", content: textParts("instance:r"), text: "instance:r" },
      { type: "work", kind: "completion" },
    ]);
    expect(calls).toEqual(["instance:r"]);

    await expect(assistant).resolves.toMatchObject({
      value: { messages: [{ type: "assistant", content: textParts("instance:r"), text: "instance:r" }] },
    });
    expect(calls).toEqual(["instance:r"]);

    const rootCompletion = await iterator.next();
    expect(rootCompletion.value?.messages[0]).toMatchObject({
      type: "work",
      kind: "completion",
    });
    expect(calls).toEqual(["instance:r"]);

    const memoryActivation = await iterator.next();
    expect(memoryActivation.value?.messages[0]).toMatchObject({
      type: "work",
      kind: "activation",
      runtimeInstanceId: "member:r/memory",
    });
    expect(calls).toEqual(["instance:r"]);
  });

  it("stops scheduling executor work while still yielding activation frames", async () => {
    const calls: string[] = [];
    const runtimeExecutor = {
      run: async (request: ExecutorRunRequest) => {
        calls.push(request.runtimeInstanceId);
        return { completionReason: "done" as const };
      },
      realizePrompt: (request: { inference: unknown }) => ({ provider: "test", input: request.inference }),
    };
    const memory = createNode({
      key: "memory",
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const root = createNode({
      key: "root",
      members: [memory],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "stop-demo",
      root: { id: "r", isSource: true, node: root },
      charter: charter({ executor: runtimeExecutor }),
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("go") }] });

    const run = runMachine(machine);
    const iterator = run[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    const rootCompletion = await iterator.next();

    expect(calls).toEqual(["instance:r"]);
    expect(rootCompletion.value?.messages[0]).toMatchObject({
      type: "work",
      kind: "completion",
      reason: "end-turn",
    });

    run.stopSchedulingWork();
    const memoryActivation = await iterator.next();
    expect(memoryActivation.value?.messages[0]).toMatchObject({
      type: "work",
      kind: "activation",
      runtimeInstanceId: "member:r/memory",
    });
    const memoryActivationId = (memoryActivation.value?.messages[0] as { activationId?: string } | undefined)
      ?.activationId;
    expect(memoryActivationId).toBeDefined();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(calls).toEqual(["instance:r"]);
    expect(
      machine.frames
        .flatMap((frame) => frame.messages)
        .some((message) =>
          message.type === "work" &&
            message.kind === "completion" &&
            message.activationId === memoryActivationId
        ),
    ).toBe(false);

    await collectFrames(runMachine(machine));
    expect(calls).toEqual(["instance:r", "member:r/memory"]);
  });

  it("reconciles deterministic activation frames idempotently without starting work", async () => {
    const root = createNode({
      key: "root",
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });

    const first = createMachine({
      id: "demo",
      root: { id: "r", isSource: true, node: root },
      charter: charter(),
    });
    first.enqueueFrame({
      id: "user-1",
      messages: [{ ...textUserMessage("hi") }],
    } as Frame);
    const firstFrames = await collectFrames(runMachine(first, { scheduleWork: false }));
    const firstActivation = firstFrames.find((item) => item.messages[0]?.type === "work");

    const second = createMachine({
      id: "demo",
      root: { id: "r", isSource: true, node: root },
      charter: charter(),
    });
    second.enqueueFrame({
      id: "user-1",
      messages: [{ ...textUserMessage("hi") }],
    } as Frame);
    const secondFrames = await collectFrames(runMachine(second, { scheduleWork: false }));
    const secondActivation = secondFrames.find((item) => item.messages[0]?.type === "work");

    expect(firstActivation?.messages[0]).toMatchObject(secondActivation?.messages[0] ?? {});
    await expect(collectFrames(runMachine(first, { scheduleWork: false }))).resolves.toEqual([]);
  });

  it("does not let a runtime actor frame trigger its own runtime again", async () => {
    const root = createNode({
      key: "root",
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "demo",
      root: { id: "r", isSource: true, node: root },
      charter: charter(),
    });
    machine.enqueueFrame({
      generatorId: "instance:r",
      runtimeInstanceId: "instance:r",
      activationId: "activation-existing",
      messages: [{ ...textAssistantMessage("self output") }],
    });

    const frames = await collectFrames(runMachine(machine, { scheduleWork: false }));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.messages[0]).toMatchObject({ type: "assistant" });
  });

  it("maps root completion reasons through the normal runtime policy", async () => {
    const runtimeExecutor = {
      run: async () => ({ completionReason: "delegated" as const }),
      realizePrompt: (request: { inference: unknown }) => ({ provider: "test", input: request.inference }),
    };
    const machine = createMachine({
      id: "root-completion-demo",
      root: createRoot([{ id: "r", isSource: true, node: createNode({ key: "root" }) }]),
      charter: charter({ executor: runtimeExecutor }),
    });
    machine.enqueueFrame({
      messages: [{ ...textUserMessage("hi") }],
    });

    const frames = await collectFrames(runMachine(machine));
    const completion = frames
      .flatMap((frame) => frame.messages)
      .find((message) => message.type === "work" && message.kind === "completion");

    expect(completion).toMatchObject({ reason: "delegated" });
  });

  it("lets external runtime turn frames trigger parent-completion generators without running the parent", async () => {
    const calls: string[] = [];
    const memoryHistoryTexts: string[] = [];
    const runtimeExecutor = {
      run: async (request: ExecutorRunRequest) => {
        calls.push(request.runtimeInstanceId);
        if (request.runtimeInstanceId === "member:r/memory") {
          memoryHistoryTexts.push(
            ...request.inference.history
              .filter(isActorMessage)
              .map((message) => message.text ?? ""),
          );
        }
        return { completionReason: "done" as const };
      },
      realizePrompt: (request: { inference: unknown }) => ({ provider: "test", input: request.inference }),
    };
    const memory = createNode({
      key: "memory",
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const root = createNode({ key: "root", members: [memory] });
    const machine = createMachine({
      id: "external-turn-demo",
      root: createRoot([{ id: "r", isSource: true, node: root }]),
      charter: charter({ executor: runtimeExecutor }),
    });
    const userTranscript = machine.enqueueFrame({
      id: "user-transcript",
      generatorId: ROOT_RUNTIME_INSTANCE_ID,
      runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
      inert: true,
      messages: [{ ...textUserMessage("voice request") }],
    } as Frame);
    const assistantTranscript = machine.enqueueFrame({
      id: "assistant-transcript",
      generatorId: ROOT_RUNTIME_INSTANCE_ID,
      runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
      inert: true,
      messages: [{ ...textAssistantMessage("voice answer") }],
    } as Frame);
    const turn = machine.enqueueFrame(createRuntimeTurnFrame({
      generatorId: ROOT_RUNTIME_INSTANCE_ID,
      runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
      activationId: "external-root-turn",
      sourceFrameId: assistantTranscript.id,
    }));

    const frames = await collectFrames(runMachine(machine));

    expect(frames[0]?.id).toBe(userTranscript.id);
    expect(frames[1]?.id).toBe(assistantTranscript.id);
    expect(frames[2]?.id).toBe(turn.id);
    expect(calls).toEqual(["member:r/memory"]);
    expect(memoryHistoryTexts).toEqual(["voice request"]);
    expect(frames.flatMap((frame) => frame.messages)).toContainEqual(
      expect.objectContaining({
        type: "work",
        kind: "activation",
        runtimeInstanceId: "member:r/memory",
        sourceFrameId: turn.id,
      }),
    );
  });

  it("activates the root runtime and structurally visible generator children", async () => {
    const calls: string[] = [];
    const runtimeExecutor = {
      run: async (request: ExecutorRunRequest) => {
        calls.push(request.runtimeInstanceId);
        return { completionReason: "delegated" as const };
      },
      realizePrompt: (request: { inference: unknown }) => ({ provider: "test", input: request.inference }),
    };
    const root = createNode({
      key: "root",
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "root-generator-demo",
      root: createRoot([{ id: "r", isSource: true, node: root }]),
      charter: charter({ executor: runtimeExecutor }),
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });

    await collectFrames(runMachine(machine));

    expect(calls).toEqual([ROOT_RUNTIME_INSTANCE_ID, "instance:r"]);
  });

  it("uses the nearest concrete generator boundary before the root runtime", async () => {
    const calls: string[] = [];
    const runtimeExecutor = {
      run: async (request: ExecutorRunRequest) => {
        calls.push(request.runtimeInstanceId);
        return { completionReason: "done" as const };
      },
      realizePrompt: (request: { inference: unknown }) => ({ provider: "test", input: request.inference }),
    };
    const memory = createNode({
      key: "memory",
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const root = createNode({
      key: "root",
      members: [memory],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "root-nearest-boundary-demo",
      root: createRoot([{ id: "r", isSource: true, node: root }]),
      charter: charter({ executor: runtimeExecutor }),
    });
    const userFrame = machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });
    const activationId = "root-activation";
    machine.enqueueFrame(createActivationFrame({
      activationId,
      runtimeInstanceId: "instance:r",
      generatorId: "instance:r",
      sourceFrameId: userFrame.id,
      concurrencyKey: "instance:r",
      concurrency: "serial",
    }));
    const rootCompletion = machine.enqueueFrame(createCompletionFrame({
      activationId,
      sourceFrameId: userFrame.id,
      reason: "end-turn",
    }));

    const frames = await collectFrames(runMachine(machine));
    const memoryActivation = frames
      .flatMap((frame) => frame.messages)
      .find((message) =>
        message.type === "work" &&
        message.kind === "activation" &&
        message.runtimeInstanceId === "member:r/memory" &&
        message.sourceFrameId === rootCompletion.id
      );

    expect(memoryActivation).toBeDefined();
    expect(calls).toContain("member:r/memory");
  });

  it("treats the root runtime as the parent runtime for generators under component children", async () => {
    const calls: string[] = [];
    const runtimeExecutor = {
      run: async (request: ExecutorRunRequest) => {
        calls.push(request.runtimeInstanceId);
        return { completionReason: "done" as const };
      },
      realizePrompt: (request: { inference: unknown }) => ({ provider: "test", input: request.inference }),
    };
    const memory = createNode({
      key: "memory",
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const root = createNode({
      key: "root",
      members: [memory],
    });
    const machine = createMachine({
      id: "root-component-child-demo",
      root: createRoot([{ id: "r", isSource: true, node: root }]),
      charter: charter({ executor: runtimeExecutor }),
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });

    await collectFrames(runMachine(machine));

    expect(calls).toEqual([ROOT_RUNTIME_INSTANCE_ID, "member:r/memory"]);
  });

  it("lets a host persist frames and sync the root runtime after each non-inert frame", async () => {
    const syncs: Array<{ visibleFrameIds: string[]; historyTexts: string[] }> = [];
    const runtimeExecutor = {
      run: async () => ({ completionReason: "delegated" as const }),
      realizePrompt: (request: { inference: unknown }) => ({ provider: "test", input: request.inference }),
      syncRuntime: async (context: Awaited<ReturnType<typeof syncMachineRuntime>>) => {
        if (!context) return;
        syncs.push({
          visibleFrameIds: context.visibleFrames.map((frame) => frame.id),
          historyTexts: context.inference.history
            .filter(isActorMessage)
            .map((message) => message.text ?? ""),
        });
      },
    };
    const machine = createMachine({
      id: "host-sync-demo",
      root: createRoot([{ id: "r", isSource: true, node: createNode({ key: "root" }) }]),
      charter: charter({ executor: runtimeExecutor }),
    });
    const transcriptFrame = machine.enqueueFrame({
      id: "transcript-1",
      inert: true,
      messages: [{ ...textUserMessage("voice transcript") }],
    } as Frame);
    const userFrame = machine.enqueueFrame({
      id: "user-1",
      messages: [{ ...textUserMessage("hi") }],
    } as Frame);
    const persisted: string[] = [];

    for await (const frame of runMachine(machine)) {
      persisted.push(frame.id);
      if (!frame.inert) {
        await syncMachineRuntime(machine, {
          runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
          visibleFrames: [frame],
        });
      }
    }

    expect(persisted[0]).toBe(transcriptFrame.id);
    expect(persisted[1]).toBe(userFrame.id);
    expect(syncs.map((sync) => sync.visibleFrameIds)).toEqual([
      [userFrame.id],
      [persisted[2]!],
      [persisted[3]!],
    ]);
    expect(syncs[0]?.historyTexts).toEqual(["voice transcript", "hi"]);
  });

  it("ingests inert frames without enqueue notifications or pending yields", async () => {
    const root = createNode({
      key: "root",
      state: {
        key: "counter",
        schema: z.object({ count: z.number() }),
        init: { count: 0 },
      },
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "inert-ingest-demo",
      root: { id: "r", isSource: true, node: root },
      charter: charter(),
    });
    const observed: string[] = [];
    machine.subscribe((frame) => {
      observed.push(frame.id);
    });

    machine.ingestInertFrame({
      id: "external-state-update",
      inert: true,
      messages: [
        {
          type: "instance",
          kind: "state.update",
          instanceId: "r",
          stateKey: "counter",
          update: { op: "patch", value: { count: 1 } },
        },
        { ...textUserMessage("imported context") },
      ],
    });

    expect(observed).toEqual([]);
    expect(resolveStates(machine.root)[0]?.container.value).toEqual({ count: 1 });
    await expect(collectFrames(runMachine(machine, { scheduleWork: false }))).resolves.toEqual([]);
  });

  it("creates external action contexts that patch and replace bound state", async () => {
    const counterState = {
      key: "counter",
      schema: z.object({ count: z.number() }),
      init: { count: 0 },
    };
    const updateCounter = createAction({
      state: counterState,
      name: "updateCounter",
    });
    const instance: Instance = {
      id: "r",
      isSource: true,
      node: createNode({
        key: "root",
        state: counterState,
        tools: [updateCounter],
        runtime: {
          type: "generator",
          trigger: { type: "actor-frame" },
          boundaryProjection: { mode: "augment" },
        },
      }),
    };
    const runtimeExecutor = {
      run: async () => ({ completionReason: "done" as const }),
      realizePrompt: (request: { inference: unknown }) => ({ provider: "test", input: request.inference }),
      syncRuntime: async (context: Awaited<ReturnType<typeof syncMachineRuntime>>) => {
        const action = context?.inference.tools.find((tool) => tool.name === "updateCounter");
        if (!context || !action) {
          throw new Error("Expected updateCounter in synced inference");
        }
        const actionContext = context.createActionContext(action);
        expect(actionContext.state).toEqual({ count: 0 });
        actionContext.updateState?.(patchState({ count: 1 }));
        expect(actionContext.state).toEqual({ count: 1 });
        actionContext.updateState?.(replaceState({ count: 2 }));
        expect(actionContext.state).toEqual({ count: 2 });
      },
    };
    const machine = createMachine({
      id: "external-action-context-demo",
      root: createRoot([instance]),
      charter: charter({ executor: runtimeExecutor }),
    });

    await syncMachineRuntime(machine, {
      runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
      visibleFrames: [],
    });

    expect(machine.root.states).toBeUndefined();
    expect(machine.root.children?.[0]?.states?.counter?.value).toEqual({ count: 2 });
    expect(machine.frames.map((frame) => frame.messages[0])).toMatchObject([
      { type: "instance", kind: "state.update", instanceId: "r", stateKey: "counter" },
      { type: "instance", kind: "state.update", instanceId: "r", stateKey: "counter" },
    ]);
  });

  it("creates external action contexts that can spawn from the source instance", async () => {
    const child = createNode({ key: "child" });
    const spawnChild = createAction({
      state: null,
      name: "spawnChild",
      run: (_input, ctx) => {
        ctx.instance.spawn(child);
      },
    });
    const instance: Instance = {
      id: "r",
      isSource: true,
      node: createNode({
        key: "root",
        tools: [spawnChild],
        runtime: {
          type: "generator",
          trigger: { type: "actor-frame" },
          boundaryProjection: { mode: "augment" },
        },
      }),
    };
    const runtimeExecutor = {
      run: async () => ({ completionReason: "done" as const }),
      realizePrompt: (request: { inference: unknown }) => ({ provider: "test", input: request.inference }),
      syncRuntime: async (context: Awaited<ReturnType<typeof syncMachineRuntime>>) => {
        const action = context?.inference.tools.find((tool) => tool.name === "spawnChild");
        if (!context || !action) {
          throw new Error("Expected spawnChild in synced inference");
        }
        const actionContext = context.createActionContext(action);
        expect(actionContext.instance.ownerInstanceId).toBe("r");
        await action.run?.({}, actionContext);
      },
    };
    const machine = createMachine({
      id: "external-action-spawn-demo",
      root: createRoot([instance]),
      charter: charter({ executor: runtimeExecutor }),
    });

    await syncMachineRuntime(machine, {
      runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
      visibleFrames: [],
    });

    expect(instance.children?.map((item) => item.node.key)).toEqual(["child"]);
    expect(machine.frames[0]).toMatchObject({
      generatorId: ROOT_RUNTIME_INSTANCE_ID,
      runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
      messages: [
        {
          type: "instance",
          kind: "spawn",
          parentInstanceId: "r",
        },
      ],
    });
  });

  it("gives unbound synthetic actions a failing instance lifecycle context", async () => {
    const state = {
      key: "memory",
      schema: z.object({ text: z.string() }),
      init: { text: "hello" },
      projection: "retrieval" as const,
      scope: "local" as const,
    };
    const child = createNode({ key: "child" });
    const instance: Instance = {
      id: "r",
      isSource: true,
      node: createNode({
        key: "root",
        state,
        runtime: {
          type: "generator",
          trigger: { type: "actor-frame" },
          boundaryProjection: { mode: "augment" },
        },
      }),
    };
    const runtimeExecutor = {
      run: async () => ({ completionReason: "done" as const }),
      realizePrompt: (request: { inference: unknown }) => ({ provider: "test", input: request.inference }),
      syncRuntime: async (context: Awaited<ReturnType<typeof syncMachineRuntime>>) => {
        const action = context?.inference.tools.find((tool) => tool.name === "getState");
        if (!context || !action) {
          throw new Error("Expected getState in synced inference");
        }
        const actionContext = context.createActionContext(action);
        expect(() => actionContext.instance.spawn(child)).toThrow(
          /Action has no source instance/,
        );
      },
    };
    const machine = createMachine({
      id: "unbound-action-context-demo",
      root: createRoot([instance]),
      charter: charter({ executor: runtimeExecutor }),
    });

    await syncMachineRuntime(machine, {
      runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
      visibleFrames: [],
    });
  });

  it("enqueues executor frames and maps text output to an assistant message", async () => {
    const audience = { type: "instance" as const, instanceId: "r" };
    const runtimeExecutor = {
      run: async (request: ExecutorRunRequest) => {
        expect(request.output?.audience).toEqual(audience);
        return {
          completionReason: "done" as const,
          frames: [{ messages: [{ type: "tool" as const, name: "trace", text: "ran" }] }],
          value: "hello from the model",
        };
      },
      realizePrompt: (request: { inference: unknown }) => ({ provider: "test", input: request.inference }),
    };
    const root = createNode({
      key: "root",
      output: { audience },
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "output-demo",
      root: { id: "r", isSource: true, node: root },
      charter: charter({ executor: runtimeExecutor }),
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });

    const frames = await collectFrames(runMachine(machine));

    expect(frames.map((frame) => frame.messages[0])).toMatchObject([
      { ...textUserMessage("hi") },
      { type: "work", kind: "activation" },
      { type: "tool", name: "trace", text: "ran" },
      {
        type: "assistant",
        content: textParts("hello from the model"),
        text: "hello from the model",
        audience,
      },
      { type: "work", kind: "completion", reason: "end-turn" },
    ]);
    expect(frames[2]).toMatchObject({
      generatorId: "instance:r",
      runtimeInstanceId: "instance:r",
    });
    expect(frames[3]).toMatchObject({
      generatorId: "instance:r",
      runtimeInstanceId: "instance:r",
    });
  });

  it("maps text output through an output schema and mapper", async () => {
    type StructuredDataContent = { answer: string };
    const structuredOutputSchema = z.object({
      answer: z.string(),
    });
    const runtimeExecutor = {
      run: async (request: ExecutorRunRequest<StructuredDataContent>) => {
        expect(request.output?.schema).toBe(structuredOutputSchema);
        return {
          completionReason: "done" as const,
          value: JSON.stringify({ answer: "yes" }),
        };
      },
      realizePrompt: (request: { inference: unknown }) => ({ provider: "test", input: request.inference }),
    };
    const root = createNode<StructuredDataContent>({
      key: "root",
      output: {
        audience: "broadcast",
        schema: structuredOutputSchema,
        mapTextBlock: (text) => ({
          answer: (JSON.parse(text) as { answer: string }).answer,
        }),
      },
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "structured-output-demo",
      root: { id: "r", isSource: true, node: root },
      charter: charter<StructuredDataContent>({ executor: runtimeExecutor }),
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });

    const frames = await collectFrames(runMachine(machine));

    expect(frames[2]?.messages[0]).toEqual({
      type: "assistant",
      content: [{ type: "data", data: { answer: "yes" } }],
      text: JSON.stringify({ answer: "yes" }),
      audience: "broadcast",
    });
  });
});

describe("serialization and refs", () => {
  it("serializes registered projection functions by name and rejects unregistered functions", () => {
    const projection = createProjectionFunction({
      name: "summary",
      method: () => {},
    });
    const registry = charter({ projections: [projection] });

    expect(serializeProjection(projection, registry)).toBe("summary");
    expect(hydrateProjection("summary", registry)).toBe(projection);
    expect(() =>
      serializeProjection(
        createProjectionFunction({ name: "missing", method: () => {} }),
        registry,
      ),
    ).toThrow(
      /unregistered projection function "missing"/,
    );
  });

  it("rejects duplicate projection function names", () => {
    expect(() =>
      charter({
        projections: [
          createProjectionFunction({ name: "duplicate", method: () => {} }),
          createProjectionFunction({ name: "duplicate", method: () => {} }),
        ],
      }),
    ).toThrow(/Duplicate projection function "duplicate"/);
  });

  it("hydrates location-aware plain refs and rejects unknown refs", () => {
    const tool: Action = { state: null, name: "search" };
    const node = createNode({ key: "agent", tools: [tool] });
    const registry = charter({ nodes: [node], tools: [tool] });

    expect(hydrateNode("agent", registry)).toBe(node);
    expect(() => hydrateProjection("search", registry)).toThrow(/Unknown projection ref/);
    expect(() => hydrateNode("missing", registry)).toThrow(/Unknown node ref/);
  });

  it("strictly hydrates inline node action refs", () => {
    const search: Action = { state: null, name: "search" };
    const approve: Action = { state: null, name: "approve" };
    const source = createNode({ key: "source", tools: [search], commands: [approve] });
    const registry = charter({ nodes: [source] });

    const hydrated = hydrateNode(
      {
        key: "inline",
        sourceNodeKey: "source",
        tools: ["search"],
        commands: ["approve"],
      },
      registry,
    );

    expect(hydrated.toolBindings.search).toBe(search);
    expect(hydrated.commandBindings.approve).toBe(approve);
    expect(() =>
      hydrateNode({ key: "missingTool", tools: ["missing"] }, registry),
    ).toThrow(/Unknown tool ref "missing"/);
    expect(() =>
      hydrateNode({ key: "missingCommand", commands: ["missing"] }, registry),
    ).toThrow(/Unknown command ref "missing"/);
  });

  it("rejects duplicate charter action refs", () => {
    const first: Action = { state: null, name: "search", description: "first" };
    const second: Action = { state: null, name: "search", description: "second" };

    expect(() => charter({ tools: [first, second] })).toThrow(
      /Duplicate tool ref "search"/,
    );
  });

  it("serializes registered states by ref, inline states by schema, and keeps members out of durable children", () => {
    const registeredState = createNode({
      key: "registeredState",
      state: { key: "thread", schema: z.object({ title: z.string() }), init: { title: "x" } },
    }).state!;
    const member = createNode({ key: "member" });
    const inline = createNode({
      key: "inline",
      members: [member],
      state: { key: "count", schema: z.number(), init: 1 },
    });
    const registered = createNode({ key: "registered", state: registeredState });
    const registry = charter({ states: [registeredState], nodes: [registered] });

    expect(serializeStateDescriptor(registeredState, registry)).toBe("thread");

    const serializedInline = serializeInstance({ id: "i", isSource: true, node: inline }, registry);
    expect(typeof serializedInline.node).not.toBe("string");
    if (typeof serializedInline.node !== "string") {
      expect(serializedInline.children).toBeUndefined();
      expect(serializedInline.node.members?.map((item) =>
        typeof item === "string" ? item : item.key
      )).toEqual(["member"]);
      expect(serializedInline.node.state).toMatchObject({ key: "count" });
      const hydratedState = hydrateStateDescriptor(serializedInline.node.state!, registry);
      expect(hydratedState.schema.parse(3)).toBe(3);
    }

    const serializedRegistered = serializeInstance({ id: "r", isSource: true, node: registered }, registry);
    expect(serializedRegistered.node).toBe("registered");

    const hydratedInline = hydrateInstance(serializedInline, registry);
    expect(hydratedInline.node.state?.schema.parse(4)).toBe(4);
  });

  it("serializes inline output schema and rejects inline output mappers", () => {
    type StructuredDataContent = { answer: string };
    const outputSchema = z.object({ answer: z.string() });
    const inline = createNode<StructuredDataContent>({
      key: "inlineOutput",
      output: { audience: "broadcast", schema: outputSchema },
    });
    const registry = charter<StructuredDataContent>({});

    const serialized = serializeInstance({ id: "i", isSource: true, node: inline }, registry);

    if (typeof serialized.node === "string") {
      throw new Error("Expected inline node serialization");
    }
    expect(serialized.node.output?.audience).toBe("broadcast");
    const hydrated = hydrateInstance(serialized, registry);
    expect(hydrated.node.output?.schema?.parse({ answer: "ok" })).toEqual({ answer: "ok" });

    const mapped = createNode<StructuredDataContent>({
      key: "mappedOutput",
      output: {
        mapTextBlock: (text) => ({ answer: text }),
      },
    });
    expect(() => serializeInstance({ id: "m", isSource: true, node: mapped }, registry)).toThrow(
      /mapTextBlock/,
    );
  });

  it("persists runtime children through serialization", () => {
    const child = createNode({ key: "child" });
    const root = createNode({ key: "root" });
    const registry = charter({});

    const serialized = serializeInstance(
      { id: "r", isSource: true, node: root, children: [{ id: "c", isSource: true, node: child }] },
      registry,
    );

    expect(serialized.children?.map((item) => item.id)).toEqual(["c"]);
  });
});

function makeGenerator(runtimeInstanceId: string, kind: "generator") {
  return { id: runtimeInstanceId, kind, runtimeInstanceId };
}

function frame(id: string, messages: Frame["messages"]): Frame {
  return { id, generatorId: id, messages };
}

async function collectFrames<TDataContent = never>(
  run: AsyncIterable<Frame<TDataContent>>,
): Promise<Frame<TDataContent>[]> {
  const frames: Frame<TDataContent>[] = [];
  for await (const frame of run) {
    frames.push(frame);
  }
  return frames;
}

function getStateJsonSchema(compiled: ReturnType<typeof compileProjection>): unknown {
  const getState = compiled.tools.find((tool) => tool.name === "getState");
  if (!getState?.inputSchema) {
    throw new Error("Expected getState tool schema");
  }
  return z.toJSONSchema(getState.inputSchema);
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
