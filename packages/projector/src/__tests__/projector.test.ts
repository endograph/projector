import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  actorMessages,
  appendState,
  compileProjection,
  createActivationFrame,
  createCompletionFrame,
  createCharter,
  createAction,
  createLayout,
  createMachine,
  actionResult,
  createHistoryProjectionFunction,
  createInstance,
  createRuntimeTurnFrame,
  createNode,
  createRoot,
  createRootInstance,
  createSlot,
  executeCommand,
  hydrateInstance,
  hydrateNode,
  hydrateStateDescriptor,
  inspectCompiledProjectionTree,
  isActorMessage,
  messagesBeforeLastCompletion,
  messagesSinceLastCompletion,
  patchState,
  recencyRegion,
  resolveStates,
  replaceState,
  resolveEffectiveParams,
  runMachine,
  serializeInstance,
  serializeNode,
  serializeStateDescriptor,
  syncMachineRuntime,
  textAssistantMessage,
  textUserMessage,
  ROOT_GENERATOR_ID,
  collectContributors,
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
  return texts.length <= 1
    ? texts.map((text) => ({ type: "text" as const, text }))
    : [{ type: "text" as const, text: texts.join("\n\n") }];
}

// Compiled-region fixtures carry the implicit-layout stamp: preamble parts
// merge into the stable default "body" slot, recency into volatile "context".
function preambleParts(...texts: string[]) {
  return textParts(...texts).map((part) => ({ ...part, slot: "body", volatile: false }));
}

function recencyParts(...texts: string[]) {
  return textParts(...texts).map((part) => ({ ...part, slot: "context", volatile: true }));
}

function charter<TDataContent = never>(
  overrides: Partial<CharterConfig<TDataContent>> = {},
): Charter<TDataContent> {
  return createCharter<TDataContent>({
    nodes: [],
    tools: [],
    commands: [],
    states: [],
    ...overrides,
  });
}

/** A one-off layout whose only job is to carry a history projection. */
function historyLayout(historyProjection: Parameters<typeof createLayout>[0]["historyProjection"]) {
  return createLayout({
    name: "historyLayout",
    historyProjection,
    regions: {
      preamble: [createSlot("body", { default: true })],
      recency: [createSlot("context", { default: true, volatile: true })],
    },
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
        nodes: [appNode],
      tools: [],
      commands: [],
      states: [],
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
        nodes: [
        // @ts-expect-error registered nodes must use the charter data content type.
        stringOutputNode,
      ],
      tools: [],
      commands: [],
      states: [],
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
      states: [state],
      members: [member],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });

    expect(node.parts).toEqual([]);
    expect(node.runtime).toMatchObject({
      type: "generator",
      concurrency: "serial",
      activationHistory: "live",
      boundaryProjection: "hidden",
    });
    expect(node.states).toHaveLength(1);
    expect(node.states[0]).toMatchObject({
      key: "memory",
      scope: "hoist",
      onInitConflict: "replace",
    });
    expect(node.states[0]?.projection).toBeUndefined();
    expect(node.memberEntries).toEqual([member]);
  });

  it("rejects duplicate member keys", () => {
    const a = createNode({ key: "a" });
    const b = createNode({ key: "a" });

    expect(() => createNode({ key: "root", members: [a, b] })).toThrow(/Duplicate member key/);
    expect(() => createNode({ key: "root", members: [a, a] })).toThrow(/Duplicate member key/);
  });
});

describe("params", () => {
  it("types charter, node, and action params compatibility", () => {
    const action = createAction({
      state: null,
      name: "loadProfile",
      params: z.object({ userId: z.string() }),
      run: (_input, ctx) => {
        expectTypeOf(ctx.params).toEqualTypeOf<{ userId: string }>();
        ctx.params.userId;
        // @ts-expect-error action params only expose action-declared keys
        ctx.params.orgId;
      },
    });

    const node = createNode({
      key: "profile",
      params: z.object({
        userId: z.string(),
        orgId: z.string(),
      }),
      tools: [action],
    });

    createCharter({
      executor,
      params: z.object({
        userId: z.string(),
        orgId: z.string(),
      }),
      nodes: [node],
      tools: [],
      commands: [],
      states: [],
    });

    expect(() =>
      createCharter({
        executor,
        params: z.object({}),
        nodes: [
          createNode({
            key: "optionalProfile",
            params: z.object({ userId: z.string().optional() }),
          }),
        ],
        tools: [],
        commands: [],
        states: [],
      }),
    ).not.toThrow();

    const memberNode = createNode({
      key: "memberProfile",
      params: z.object({ orgId: z.string() }),
    });
    createCharter({
      executor,
      params: z.object({
        userId: z.string(),
        orgId: z.string(),
      }),
      nodes: [
        createNode({
          key: "memberOwner",
          params: z.object({ userId: z.string() }),
          members: [memberNode],
        }),
      ],
      tools: [],
      commands: [],
      states: [],
    });

    if (false) {
      // @ts-expect-error node params must satisfy attached action params
      createNode({
        key: "badActionNode",
        params: z.object({ orgId: z.string() }),
        tools: [action],
      });

      // @ts-expect-error charter params must satisfy node params
      createCharter({
        executor,
        params: z.object({ userId: z.string() }),
        nodes: [node],
        tools: [],
        commands: [],
        states: [],
      });

      // @ts-expect-error charter params must satisfy member node params
      createCharter({
        executor,
        params: z.object({ userId: z.string() }),
        nodes: [
          createNode({
            key: "badMemberOwner",
            params: z.object({ userId: z.string() }),
            members: [memberNode],
          }),
        ],
        tools: [],
        commands: [],
        states: [],
      });
    }
  });

  it("parses createRoot params and validates machine params", () => {
    const rootNode = createNode({ key: "app" });
    const appCharter = charter({
      params: z.object({ userId: z.string() }),
      nodes: [rootNode],
    });
    const source = createInstance({ id: "app", node: rootNode, isSource: true });

    expect(() => createRoot(appCharter, [source], { userId: 123 })).toThrow();

    const instance = createRoot(appCharter, [source], { userId: "user_123" });
    expect(instance.params).toEqual({ userId: "user_123" });

    expect(() =>
      createMachine({
        charter: appCharter,
        instance: { id: "custom", node: rootNode, isSource: true },
      }),
    ).toThrow();

    expect(() =>
      createMachine({
        charter: appCharter,
        instance: {
          id: "custom",
          node: rootNode,
          isSource: true,
          params: { userId: "user_123" },
        },
      }),
    ).not.toThrow();
  });

  it("resolves shallow instance params and rejects overrides", () => {
    const rootNode = createNode({ key: "root" });
    const childNode = createNode({ key: "child" });
    const child = createInstance({
      id: "child",
      node: childNode,
      isSource: true,
    });
    child.params = { documentId: "doc_456" };
    const instance: Instance = {
      id: "top",
      node: rootNode,
      params: { userId: "user_123" },
      children: [child],
    };

    expect(resolveEffectiveParams([instance, child])).toEqual({
      userId: "user_123",
      documentId: "doc_456",
    });

    child.params = { userId: "user_999" };
    expect(() => resolveEffectiveParams([instance, child])).toThrow(
      /Param override is not supported yet: userId/,
    );
  });

  it("passes action-local params through command contexts", async () => {
    let observed: unknown;
    const command = createAction({
      state: null,
      name: "readParams",
      params: z.object({ userId: z.string() }),
      run: (_input, ctx) => {
        observed = ctx.params;
      },
    });
    const node = createNode({
      key: "profile",
      params: z.object({
        userId: z.string(),
        orgId: z.string(),
      }),
      commands: [command],
    });
    const machine = createMachine({
      charter: charter({
        params: z.object({
          userId: z.string(),
          orgId: z.string(),
        }),
        nodes: [node],
      }),
      instance: {
        id: "profile",
        node,
        isSource: true,
        params: {
          userId: "user_123",
          orgId: "org_456",
        },
      },
    });

    await executeCommand(machine, {
      type: "action",
      kind: "request",
      action: "command",
      name: "readParams",
      input: null,
      callId: "call-1",
    });

    expect(observed).toEqual({ userId: "user_123" });
  });

  it("provides node-scoped params to history projection contexts", () => {
    let historyParams: unknown;
    const captureHistoryParams = createHistoryProjectionFunction({
      name: "captureHistoryParams",
      method: (ctx) => {
        historyParams = ctx.params;
        return [];
      },
    });
    const generator = createNode({
      key: "generator",
      params: z.object({ tone: z.string() }),
      runtime: {
        type: "generator",
        trigger: { type: "parent-completion" },
      },
    });
    const root = createNode({ key: "root", members: [generator] });

    compileProjection(
      {
        id: "r",
        isSource: true,
        node: root,
        params: { tone: "wry", audience: "kids" },
      },
      {
        targetGeneratorId: "member:r/generator",
        frameHistory: [],
        layout: historyLayout(captureHistoryParams),
      },
    );

    expect(historyParams).toEqual({ tone: "wry" });
  });

  it("serializes and hydrates instance and node params", () => {
    const node = createNode({
      key: "profile",
      params: z.object({ userId: z.string() }),
    });
    const appCharter = charter({
      params: z.object({ userId: z.string() }),
      nodes: [node],
    });
    const instance: Instance = {
      id: "profile",
      node,
      isSource: true,
      params: { userId: "user_123" },
    };

    const serialized = serializeInstance(instance, appCharter);
    expect(serialized.params).toEqual({ userId: "user_123" });
    expect(typeof serialized.node).toBe("string");

    const hydrated = hydrateInstance(serialized, appCharter);
    expect(hydrated.params).toEqual({ userId: "user_123" });
    expect(hydrated.node.params.parse({ userId: "user_456" })).toEqual({
      userId: "user_456",
    });
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

    const node = createNode({ key: "counter", states: [counterState], commands: [setCounter] });
    expect(node.parts).toEqual([{ kind: "action", caller: "external", action: setCounter }]);
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
        instance: { id: "r", isSource: true, node: createNode({ key: "missing-state", commands: [setCounter] }) },
        charter: charter(),
      }),
    ).toThrow(/requires state "counter" but the node declares: none/);

    expect(() =>
      createMachine({
        instance: {
          id: "r",
          isSource: true,
          node: createNode({ key: "profile", states: [profileState], commands: [setCounter] }),
        },
        charter: charter(),
      }),
    ).toThrow(/requires state "counter" but the node declares: "profile"/);
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
    const node = createNode({ key: "counter", states: [ownerState], tools: [readCounter] });

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
    const root = createRootInstance([
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

    expect(collectContributors(root).map((frame) => frame.node.key)).toEqual([
      "root",
      "rootA",
      "critic",
      "childA",
      "childB",
      "rootB",
    ]);
    expect(collectContributors(root)[1]?.parent?.id).toBe(ROOT_GENERATOR_ID);
  });

  it("rejects duplicate instance ids without reserving root globally", () => {
    const node = createNode({ key: "node" });

    expect(() => createRootInstance([{ id: "root", node }])).toThrow(/Duplicate instance id "root"/);
    expect(() => createMachine({
      instance: { id: "root", isSource: true, node },
      charter: charter(),
    })).not.toThrow();
    expect(() => createMachine({
      instance: { id: "custom", isSource: true, node },
      charter: charter(),
    })).not.toThrow();
    expect(() => createMachine({
      instance: {
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

    expect(collectContributors(instanceA).map((frame) => frame.id)).toContain(
      "member:abc/research/retriever",
    );
    expect(collectContributors(instanceB).map((frame) => frame.id)).toContain(
      "member:abc/research/retriever",
    );
    expect(instanceA.children).toBeUndefined();
  });
});

describe("projection compilation", () => {
  it("hides runtime boundaries by default and forwards augment boundaries as compiled", () => {
    const inside = createNode({ key: "inside", instructions: "inside" });
    const generator = createNode({
      key: "generator",
      instructions: "generator",
      members: [inside],
      runtime: {
        type: "generator",
        trigger: { type: "spawn" },
        boundaryProjection: "augment",
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
    expect(parent.preamble).toEqual(preambleParts("root", "generator", "inside"));
    expect(parent.recency).toEqual([]);
    expect(parent.preamble.map((part) => (part.type === "text" ? part.text : "")).join("\n")).not.toContain("hiddenWorker");

    const own = compileProjection(
      { id: "r", isSource: true, node: root },
      {
        targetGeneratorId: "member:r/generator",
      },
    );
    expect(own.preamble).toEqual(preambleParts("generator", "inside"));
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
        boundaryProjection: "augment",
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
    expect(rootProjection?.boundaryProjection).toBe("hidden");
    expect(generatorProjection?.boundaryProjection).toBe("augment");
    expect(rootProjection?.compiled.preamble).toEqual(preambleParts("root", "generator", "inside"));
    expect(rootProjection?.compiled.recency).toEqual([]);
    expect(rootProjection?.contributors.map((contributor) => contributor.nodeKey)).toEqual(["root"]);
    expect(generatorProjection?.nodeKey).toBe("generator");
    expect(generatorProjection?.kind).toBe("generator");
    expect(generatorProjection?.compiled.preamble).toEqual(preambleParts("generator", "inside"));
    expect(generatorProjection?.contributors.map((contributor) => contributor.nodeKey)).toEqual([
      "generator",
      "inside",
    ]);
    expect(generatorProjection?.parentId).toBe("instance:r");
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
    expect(tree.roots[0]?.compiled.preamble).toEqual(preambleParts("root"));
    expect(tree.roots[0]?.compiled.preamble.map((part) => (part.type === "text" ? part.text : "")).join("\n")).not.toContain("hiddenWorker");
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
      { targetGeneratorId: "member:r/generator" },
    );

    expect(compiled.preamble).toEqual(preambleParts("generator"));
    expect(compiled.tools.map((entry) => entry.name)).toEqual(["save"]);
  });

  it("projects fully compiled child generators through their boundaryProjection", () => {
    const leaf = createNode({
      key: "leaf",
      instructions: "leaf",
      runtime: {
        type: "generator",
        trigger: { type: "parent-completion" },
        boundaryProjection: "augment",
      },
    });
    const generator = createNode({
      key: "generator",
      instructions: "generator",
      members: [leaf],
      runtime: {
        type: "generator",
        trigger: { type: "spawn" },
        boundaryProjection: "augment",
      },
    });
    const root = createNode({ key: "root", instructions: "root", members: [generator] });

    const compiled = compileProjection({ id: "r", isSource: true, node: root });

    expect(compiled.preamble).toEqual(preambleParts("root", "generator", "leaf"));
    expect(compiled.recency).toEqual([]);
  });
});

describe("state resolution and state projection", () => {
  it("resolves local state at the owner and hoist state at a direct root without attaching", () => {
    const local = createNode({
      key: "local",
      states: [{ key: "local", scope: "local", schema: z.number(), init: 1 }],
    });
    const hoist = createNode({
      key: "hoist",
      states: [{ key: "hoist", scope: "hoist", schema: z.number(), init: 2 }],
    });
    const root = createNode({ key: "root", members: [local], states: undefined });
    const childRoot = createNode({ key: "childRoot", members: [hoist] });
    const instance: Instance = {
      id: "root",
      node: root,
      children: [{ id: "child", isSource: true, node: childRoot }],
    };

    const resolved = resolveStates(instance);

    const byKey = Object.fromEntries(resolved.map((state) => [state.address.stateKey, state]));
    expect(byKey.local?.address).toEqual({ instanceId: "root", stateKey: "local" });
    expect(byKey.local?.container.value).toBe(1);
    expect(byKey.local?.realized).toBe(false);
    expect(byKey.hoist?.address).toEqual({ instanceId: "child", stateKey: "hoist" });
    expect(byKey.hoist?.container.value).toBe(2);
    expect(byKey.hoist?.realized).toBe(false);
    // Unrealized state never attaches on a read path.
    expect(instance.states).toBeUndefined();
    expect(instance.children?.[0]?.states).toBeUndefined();
  });

  it("skips the non-source createRoot wrapper for hoist state ownership", () => {
    const memory = createNode({
      key: "memory",
      states: [{ key: "hoist", scope: "hoist", schema: z.number(), init: 2 }],
    });
    const app = createNode({ key: "app", members: [memory] });
    const root = createRootInstance([{ id: "app", isSource: true, node: app }]);

    const resolved = resolveStates(root);

    expect(root.states).toBeUndefined();
    expect(resolved[0]?.address).toEqual({ instanceId: "app", stateKey: "hoist" });
    expect(resolved[0]?.container.value).toBe(2);
    // Placement is derived (the wrapper is skipped) but nothing attaches
    // until a logged write realizes the container.
    expect(root.children?.[0]?.states).toBeUndefined();
  });

  it("shares compatible state keys and applies latest projection config", () => {
    const stateA = {
      key: "shared",
      schema: z.object({ value: z.number() }),
      init: { value: 1 },
      projection: {},
    };
    const stateB = {
      key: "shared",
      schema: z.object({ value: z.number() }),
      init: { value: 1 },
      projection: { slot: recencyRegion },
    };
    const a = createNode({ key: "a", states: [stateA] });
    const b = createNode({ key: "b", states: [stateB] });
    const root = createNode({ key: "root", members: [a, b] });
    const instance: Instance = { id: "r", isSource: true, node: root };

    const states = resolveStates(instance);
    expect(states).toHaveLength(1);
    expect(states[0]?.descriptor.projection).toBe(stateB.projection);
    expect(compileProjection(instance).recency).toEqual(recencyParts('State `shared`: {"value":1}'));
  });

  it("detects incompatible descriptors and init conflicts", () => {
    const local = createNode({
      key: "local",
      states: [{ key: "x", scope: "local", schema: z.number(), init: 1 }],
    });
    const hoist = createNode({
      key: "hoist",
      states: [{ key: "x", scope: "hoist", schema: z.number(), init: 1 }],
    });
    expect(() => resolveStates({ id: "r", isSource: true, node: createNode({ key: "root", members: [local, hoist] }) }))
      .toThrow(/scopes differ/);

    const number = createNode({
      key: "number",
      states: [{ key: "x", schema: z.number(), init: 1 }],
    });
    const string = createNode({
      key: "string",
      states: [{ key: "x", schema: z.string(), init: "1" }],
    });
    expect(() =>
      resolveStates({ id: "r", isSource: true, node: createNode({ key: "root", members: [number, string] }) }),
    ).toThrow(/Conflicting init|schema validation/);

    const one = createNode({ key: "one", states: [{ key: "x", schema: z.number(), init: 1 }] });
    const two = createNode({ key: "two", states: [{ key: "x", schema: z.number(), init: 2 }] });
    expect(() =>
      resolveStates({ id: "r", isSource: true, node: createNode({ key: "root", members: [one, two] }) }),
    ).toThrow(/Conflicting init/);
  });

  it("accepts equivalent JSON init and same init function but rejects different functions", () => {
    const init = () => 1;
    const jsonA = createNode({
      key: "jsonA",
      states: [{ key: "x", schema: z.object({ a: z.number(), b: z.number() }), init: { a: 1, b: 2 } }],
    });
    const jsonB = createNode({
      key: "jsonB",
      states: [{ key: "x", schema: z.object({ a: z.number(), b: z.number() }), init: { b: 2, a: 1 } }],
    });
    expect(() =>
      resolveStates({ id: "r", isSource: true, node: createNode({ key: "root", members: [jsonA, jsonB] }) }),
    ).not.toThrow();

    const fnA = createNode({ key: "fnA", states: [{ key: "x", schema: z.number(), init }] });
    const fnB = createNode({ key: "fnB", states: [{ key: "x", schema: z.number(), init }] });
    expect(() =>
      resolveStates({ id: "r", isSource: true, node: createNode({ key: "root", members: [fnA, fnB] }) }),
    ).not.toThrow();

    const fnC = createNode({ key: "fnC", states: [{ key: "x", schema: z.number(), init: () => 1 }] });
    expect(() =>
      resolveStates({ id: "r", isSource: true, node: createNode({ key: "root", members: [fnA, fnC] }) }),
    ).toThrow(/Conflicting init/);
  });

  it("replaces or rejects invalid existing state according to the strictest policy", () => {
    const replacing = createNode({
      key: "replace",
      states: [{ key: "x", schema: z.number(), init: 1, onInitConflict: "replace" }],
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
      states: [{ key: "x", schema: z.number(), init: 1, onInitConflict: "error" }],
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
        states: [{ key, schema: z.number(), init: 1, projection: { exposure: "deferred" }, scope: "local" }],
      });
    const root = createRootInstance([
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
        states: [{ key: stateKey, schema: z.number(), init: 1, projection: { exposure: "deferred" }, scope: "local" }],
      });
    const unique = compileProjection({ id: "one", isSource: true, node: state("one", "memory") });
    const duplicate = compileProjection(
      createRootInstance([
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

  it("rejects reserved state key characters before alias generation", () => {
    const retrieval = (nodeKey: string, stateKey: string) =>
      createNode({
        key: nodeKey,
        states: [{ key: stateKey, schema: z.number(), init: 1, projection: { exposure: "deferred" }, scope: "local" }],
      });

    expect(() => retrieval("collision", "a:x")).toThrow(/cannot contain/);
    expect(() => retrieval("slash", "a/x")).toThrow(/cannot contain/);
  });

  it("reserves the getState tool name when retrieval state is projected", () => {
    const root = createNode({
      key: "root",
      tools: [{ state: null, name: "getState" }],
      states: [{ key: "memory", schema: z.number(), init: 1, projection: { exposure: "deferred" } }],
    });

    expect(() => compileProjection({ id: "r", isSource: true, node: root })).toThrow(/reserved for state retrieval/);
  });

  it("keeps retrieval aliases behind hidden boundaries", () => {
    const boundary = createNode({
      key: "boundary",
      states: [{ key: "hidden", schema: z.number(), init: 2, projection: { exposure: "deferred" as const }, scope: "local" }],
      runtime: {
        type: "generator",
        trigger: { type: "spawn" },
      },
    });
    const root = createNode({ key: "root", members: [boundary] });

    const parentCompiled = compileProjection({ id: "parent", isSource: true, node: root });
    expect(parentCompiled.retrievableStates).toEqual([]);
    expect(parentCompiled.preamble).toEqual([]);
    expect(parentCompiled.tools).toEqual([]);
  });

  it("projects hoist-scoped generator member state from the owner while hiding generator tools", () => {
    const generatorTool = createAction({ state: null, name: "generatorTool" });
    const generator = createNode({
      key: "generator",
      states: [{
        key: "memories",
        schema: z.array(z.object({ text: z.string() })),
        init: [],
        projection: { slot: recencyRegion },
      }],
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
      { targetGeneratorId: "instance:r" },
    );

    expect(compiled.recency).toContainEqual({ type: "text", text: "State `memories`: []", slot: "context", volatile: true });
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
      targetGeneratorId: "member:r/generator",
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

  it("lets layout history projection return synthetic messages from frames and state", () => {
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
      states: [{
        key: "memory",
        schema: z.object({ memories: z.array(z.string()) }),
        init: { memories: ["existing"] },
      }],
      runtime: {
        type: "generator",
        trigger: { type: "parent-completion" },
      },
    });
    const root = createNode({ key: "root", members: [generator] });
    const instance: Instance = { id: "r", isSource: true, node: root };

    const compiled = compileProjection(instance, {
      targetGeneratorId: "member:r/generator",
      frameHistory: [frame("one", [{ ...textUserMessage("remember tea") }])],
      layout: historyLayout(projection),
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
      states: [{ key: "shared", schema: z.number(), init: 1, scope: "local" }],
      runtime: {
        type: "generator",
        trigger: { type: "actor-frame" },
      },
    });

    const compiled = compileProjection(
      createRootInstance([
        { id: "a", node },
        { id: "b", node },
      ]),
      {
        targetGeneratorId: "instance:a",
        frameHistory: [],
        layout: historyLayout(projection),
      },
    );

    expect(compiled.history).toEqual([
      textUserMessage(JSON.stringify({ "shared:a": 1, "shared:b": 1 })),
    ]);
  });

  it("projects messages before and since the target generator's last completion", () => {
    const ctx = {
      generatorId: "member:r/memory",
      activationId: "activation-2",
      trigger: { type: "parent-completion" as const },
      states: {},
      params: {},
      history: [
        frame("before", [{ ...textUserMessage("old") }]),
        {
          id: "completion",
          ...createCompletionFrame({
            generatorId: "member:r/memory",
            activationId: "activation-1",
            reason: "done",
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

  it("resolves layout history projection refs through the charter registry", () => {
    const historyProjection = createHistoryProjectionFunction({
      name: "memory",
      method: () => [textUserMessage("from-registry")],
    });
    const generator = createNode({
      key: "generator",
      runtime: { type: "generator", trigger: { type: "parent-completion" } },
    });
    const root = createNode({ key: "root", members: [generator] });
    const registry = charter({ nodes: [root], historyProjections: [historyProjection] });

    const compiled = compileProjection(
      { id: "r", isSource: true, node: root },
      {
        charter: registry,
        targetGeneratorId: "member:r/generator",
        frameHistory: [frame("one", [{ ...textUserMessage("ignored") }])],
        layout: historyLayout("memory"),
      },
    );

    expect(compiled.history).toEqual([textUserMessage("from-registry")]);
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
    const generatorId = "member:r/generator";
    const activationId = "activation-1";

    const compiled = compileProjection(
      { id: "r", isSource: true, node: root },
      {
        targetGeneratorId: generatorId,
        activationId,
        frameHistory: [
          frame("before", [{ ...textUserMessage("queued before"), delivery: "queued" }]),
          frame("self-other", [{ ...textAssistantMessage("hidden self") }]),
          {
            id: "activation",
            ...createActivationFrame({
              activationId,
              generatorId,
              sourceFrameId: "before",
              concurrencyKey: generatorId,
              concurrency: "serial",
            }),
          },
          frame("after", [{ ...textUserMessage("hidden by snapshot") }]),
          frame("queued-after", [
            { ...textUserMessage("hidden queued"), delivery: "queued" },
          ]),
          {
            id: "same-activation",
            generatorId,
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
        generatorId,
        sourceFrameId: "before",
        concurrencyKey: generatorId,
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
      states: [counterState],
      commands: [setCounter],
    });
    const root = createNode({ key: "root", members: [controls] });
    const instance: Instance = { id: "r", isSource: true, node: root };
    const machine = createMachine({
      instance: instance,
      charter: charter(),
    });

    await expect(
      executeCommand(machine, {
        type: "action",
        kind: "request",
        action: "command",
        name: "setCounter",
        input: { value: 4 },
        target: { type: "member", ownerInstanceId: "r", memberPath: ["controls"] },
        callId: "call-1",
      }),
    ).resolves.toEqual({
      success: true,
      value: { ...textAssistantMessage("updated"), audience: "broadcast" },
      callId: "call-1",
    });

    expect(instance.states?.counter?.value).toEqual({ count: 4 });
    expect(machine.frames).toHaveLength(1);
    expect(machine.frames[0]?.messages).toMatchObject([
      { type: "action", kind: "request", action: "command", name: "setCounter", callId: "call-1" },
      { type: "instance", kind: "state.update", instanceId: "r", stateKey: "counter" },
      { type: "instance", kind: "state.update", instanceId: "r", stateKey: "counter" },
      {
        type: "action",
        kind: "result",
        action: "command",
        name: "setCounter",
        callId: "call-1",
        success: true,
        value: { ...textAssistantMessage("updated"), audience: "broadcast" },
      },
    ]);
  });

  it("keeps output message indices aligned when merging synchronous command frames", async () => {
    const counterState = {
      key: "counter",
      schema: z.object({ count: z.number() }),
      init: { count: 0 },
    };
    const announceCounter = createAction({
      state: counterState,
      name: "announceCounter",
      run: (_input, ctx) => {
        ctx.updateState?.(patchState({ count: 1 }));
        const message = textAssistantMessage("counter updated");
        return actionResult({ value: message, messages: [message] });
      },
    });
    const instance: Instance = {
      id: "r",
      isSource: true,
      node: createNode({
        key: "root",
        states: [counterState],
        commands: [announceCounter],
      }),
    };
    const machine = createMachine({
      instance: instance,
      charter: charter(),
    });

    await executeCommand(machine, {
      type: "action",
      kind: "request",
      action: "command",
      name: "announceCounter",
      input: {},
      callId: "announce-counter",
    });

    expect(machine.frames).toHaveLength(1);
    expect(machine.frames[0]?.messages).toMatchObject([
      { type: "action", kind: "request", callId: "announce-counter" },
      { type: "instance", kind: "state.update", stateKey: "counter" },
      {
        type: "action",
        kind: "result",
        callId: "announce-counter",
        outputMessageIndices: [3],
      },
      { type: "assistant", text: "counter updated" },
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
        states: [logState],
        commands: [appendLog],
      }),
    };
    const machine = createMachine({
      instance: instance,
      charter: charter(),
    });

    await executeCommand(machine, {
      type: "action",
      kind: "request",
      action: "command",
      name: "appendLog",
      input: { value: "created" },
      callId: "append-log",
    });

    expect(instance.states?.log?.value).toEqual(["created", "indexed"]);
    expect(machine.frames).toHaveLength(1);
    expect(machine.frames[0]?.messages[1]).toMatchObject({
      type: "instance",
      kind: "state.update",
      instanceId: "r",
      stateKey: "log",
      update: { op: "append", values: ["created", "indexed"] },
    });
  });

  it("splits async command request and result frames", async () => {
    let resolveCommand!: () => void;
    const pendingCommand = new Promise<void>((resolve) => {
      resolveCommand = resolve;
    });
    const wait = createAction({
      state: null,
      name: "wait",
      run: async () => {
        await pendingCommand;
        return "done";
      },
    });
    const instance: Instance = {
      id: "r",
      isSource: true,
      node: createNode({ key: "root", commands: [wait] }),
    };
    const machine = createMachine({
      instance: instance,
      charter: charter(),
    });

    const result = executeCommand(machine, {
      type: "action",
      kind: "request",
      action: "command",
      name: "wait",
      input: {},
      callId: "wait-command",
    });

    expect(machine.frames).toHaveLength(1);
    expect(machine.frames[0]?.messages).toMatchObject([
      { type: "action", kind: "request", action: "command", name: "wait", callId: "wait-command" },
    ]);

    resolveCommand();
    await expect(result).resolves.toEqual({
      success: true,
      value: "done",
      callId: "wait-command",
    });
    expect(machine.frames).toHaveLength(2);
    expect(machine.frames[1]?.messages).toMatchObject([
      { type: "action", kind: "result", action: "command", name: "wait", callId: "wait-command", success: true },
    ]);
  });

  it("evaluates functional state updates against the latest state after awaits", async () => {
    let releaseCommands!: () => void;
    const commandGate = new Promise<void>((resolve) => {
      releaseCommands = resolve;
    });
    const counterState = {
      key: "counter",
      schema: z.object({ count: z.number() }),
      init: { count: 0 },
    };
    const increment = createAction({
      state: counterState,
      name: "increment",
      inputSchema: z.object({ amount: z.number() }),
      run: async ({ amount }, ctx) => {
        await commandGate;
        ctx.updateState?.((state) => patchState({ count: state.count + amount }));
      },
    });
    const instance: Instance = {
      id: "r",
      isSource: true,
      node: createNode({
        key: "root",
        states: [counterState],
        commands: [increment],
      }),
    };
    const machine = createMachine({
      instance: instance,
      charter: charter(),
    });

    const first = executeCommand(machine, {
      type: "action",
      kind: "request",
      action: "command",
      name: "increment",
      input: { amount: 1 },
      callId: "increment-1",
    });
    const second = executeCommand(machine, {
      type: "action",
      kind: "request",
      action: "command",
      name: "increment",
      input: { amount: 2 },
      callId: "increment-2",
    });

    // Unrealized until the gated updates land: the updaters read init as
    // `current`, and the first logged write attaches the container.
    expect(instance.states?.counter).toBeUndefined();
    releaseCommands();
    await Promise.all([first, second]);

    expect(instance.states?.counter?.value).toEqual({ count: 3 });
    expect(machine.frames.map((frame) => frame.messages)).toMatchObject([
      [{ type: "action", kind: "request", callId: "increment-1" }],
      [{ type: "action", kind: "request", callId: "increment-2" }],
      [{ type: "instance", kind: "state.update", update: { op: "patch", value: { count: 1 } } }],
      [{ type: "instance", kind: "state.update", update: { op: "patch", value: { count: 3 } } }],
      [{ type: "action", kind: "result", callId: "increment-1", success: true }],
      [{ type: "action", kind: "result", callId: "increment-2", success: true }],
    ]);
  });

  it("folds spawn messages and derives spawn-triggered runtime work", async () => {
    const generator = createNode({
      key: "generator",
      states: [{
        key: "spawned",
        schema: z.object({ ready: z.boolean() }),
        init: { ready: false },
      }],
      runtime: { type: "generator", trigger: { type: "spawn" } },
    });
    const root = createNode({ key: "root" });
    const instance: Instance = { id: "r", isSource: true, node: root };
    const machine = createMachine({
      id: "spawn-demo",
      instance: instance,
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
      instance: instance,
      charter: charter(),
    });

    await executeCommand(machine, {
      type: "action",
      kind: "request",
      action: "command",
      name: "spawnChild",
      input: {},
      target: { type: "member", ownerInstanceId: "r", memberPath: ["controls"] },
      callId: "spawn-member-child",
    });

    expect(instance.children?.map((item) => item.node.key)).toEqual(["child"]);
    expect(machine.frames).toHaveLength(1);
    expect(machine.frames[0]?.messages[1]).toMatchObject({
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
      instance: instance,
      charter: charter(),
    });

    await executeCommand(machine, {
      type: "action",
      kind: "request",
      action: "command",
      name: "spawnChild",
      input: {},
      callId: "spawn-concrete-child",
    });

    expect(instance.children?.map((item) => item.node.key)).toEqual(["child"]);
    expect(machine.frames).toHaveLength(1);
    expect(machine.frames[0]?.messages[1]).toMatchObject({
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
      instance: instance,
      charter: charter(),
    });

    await executeCommand(machine, {
      type: "action",
      kind: "request",
      action: "command",
      name: "cedeCamera",
      input: {},
      target: { type: "member", ownerInstanceId: "r", memberPath: ["controls"] },
      callId: "cede-camera",
    });

    expect(instance.children?.map((item) => item.id)).toEqual(["other-1"]);
    expect(machine.frames).toHaveLength(1);
    expect(machine.frames[0]?.messages.slice(1, -1)).toMatchObject([
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
      instance: instance,
      charter: charter(),
    });

    await executeCommand(machine, {
      type: "action",
      kind: "request",
      action: "command",
      name: "transitionOwner",
      input: {},
      target: { type: "member", ownerInstanceId: "r", memberPath: ["controls"] },
      callId: "transition-owner",
    });

    expect(instance.node.key).toBe("next");
    expect(machine.frames).toHaveLength(1);
    expect(machine.frames[0]?.messages[1]).toMatchObject({
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
      instance: instance,
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

    expect(instance.children?.[0]?.node.parts).toEqual([
      { kind: "action", caller: "generator", action: search },
    ]);
    expect(machine.frames[0]?.messages[0]).toMatchObject({
      type: "instance",
      kind: "spawn",
      children: [{ node: { parts: [{ kind: "action", caller: "generator", ref: "search" }] } }],
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
      parts: [{ kind: "action", caller: "generator", ref: "search" }],
    });
    const hydrated = hydrateNode(serialized, registry);
    const compiled = compileProjection({ id: "i", isSource: true, node: hydrated }, { charter: registry });
    expect(compiled.tools.map((tool) => tool.description)).toEqual(["source"]);
    expect(hydrated.parts).toEqual([{ kind: "action", caller: "generator", action: search }]);
  });
});

describe("work scheduling", () => {
  it("yields activation and completion work frames in host-gated order", async () => {
    const calls: string[] = [];
    const runtimeExecutor = {
      run: async (request: ExecutorRunRequest) => {
        calls.push(request.generatorId);
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
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
      executor: runtimeExecutor,
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
        calls.push(request.generatorId);
        if (request.generatorId === "instance:r") {
          await rootStep;
        }
        return {
          completionReason: "done" as const,
          value: request.generatorId,
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
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
      executor: runtimeExecutor,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("go") }] });

    const iterator = runMachine(machine)[Symbol.asyncIterator]();
    await iterator.next();
    const activation = await iterator.next();

    expect(activation.value?.messages[0]).toMatchObject({
      type: "work",
      kind: "activation",
      generatorId: "instance:r",
    });
    expect(calls).toEqual([]);

    const assistant = iterator.next();
    await flushPromises();
    expect(calls).toEqual(["instance:r"]);
    releaseRoot();
    await flushPromises();

    expect(machine.frames.map((frame) => frame.messages[0])).toMatchObject([
      { type: "user" },
      { type: "work", kind: "activation", generatorId: "instance:r" },
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
      generatorId: "member:r/memory",
    });
    expect(calls).toEqual(["instance:r"]);
  });

  it("stops scheduling executor work while still yielding activation frames", async () => {
    const calls: string[] = [];
    const runtimeExecutor = {
      run: async (request: ExecutorRunRequest) => {
        calls.push(request.generatorId);
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
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
      executor: runtimeExecutor,
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
      generatorId: "member:r/memory",
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
      instance: { id: "r", isSource: true, node: root },
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
      instance: { id: "r", isSource: true, node: root },
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
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
    });
    machine.enqueueFrame({
      generatorId: "instance:r",
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
      instance: createRootInstance([{ id: "r", isSource: true, node: createNode({ key: "root" }) }]),
      charter: charter(),
      executor: runtimeExecutor,
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
        calls.push(request.generatorId);
        if (request.generatorId === "member:r/memory") {
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
      instance: createRootInstance([{ id: "r", isSource: true, node: root }]),
      charter: charter(),
      executor: runtimeExecutor,
    });
    const userTranscript = machine.enqueueFrame({
      id: "user-transcript",
      generatorId: ROOT_GENERATOR_ID,
      inert: true,
      messages: [{ ...textUserMessage("voice request") }],
    } as Frame);
    const assistantTranscript = machine.enqueueFrame({
      id: "assistant-transcript",
      generatorId: ROOT_GENERATOR_ID,
      inert: true,
      messages: [{ ...textAssistantMessage("voice answer") }],
    } as Frame);
    const turn = machine.enqueueFrame(createRuntimeTurnFrame({
      generatorId: ROOT_GENERATOR_ID,
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
        generatorId: "member:r/memory",
        sourceFrameId: turn.id,
      }),
    );
  });

  it("activates the root runtime and structurally visible generator children", async () => {
    const calls: string[] = [];
    const runtimeExecutor = {
      run: async (request: ExecutorRunRequest) => {
        calls.push(request.generatorId);
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
      instance: createRootInstance([{ id: "r", isSource: true, node: root }]),
      charter: charter(),
      executor: runtimeExecutor,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });

    await collectFrames(runMachine(machine));

    expect(calls).toEqual([ROOT_GENERATOR_ID, "instance:r"]);
  });

  it("uses the nearest concrete generator boundary before the root runtime", async () => {
    const calls: string[] = [];
    const runtimeExecutor = {
      run: async (request: ExecutorRunRequest) => {
        calls.push(request.generatorId);
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
      instance: createRootInstance([{ id: "r", isSource: true, node: root }]),
      charter: charter(),
      executor: runtimeExecutor,
    });
    const userFrame = machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });
    const activationId = "root-activation";
    machine.enqueueFrame(createActivationFrame({
      activationId,
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
        message.generatorId === "member:r/memory" &&
        message.sourceFrameId === rootCompletion.id
      );

    expect(memoryActivation).toBeDefined();
    expect(calls).toContain("member:r/memory");
  });

  it("treats the root generator as the parent generator for generators under component children", async () => {
    const calls: string[] = [];
    const runtimeExecutor = {
      run: async (request: ExecutorRunRequest) => {
        calls.push(request.generatorId);
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
      instance: createRootInstance([{ id: "r", isSource: true, node: root }]),
      charter: charter(),
      executor: runtimeExecutor,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });

    await collectFrames(runMachine(machine));

    expect(calls).toEqual([ROOT_GENERATOR_ID, "member:r/memory"]);
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
      instance: createRootInstance([{ id: "r", isSource: true, node: createNode({ key: "root" }) }]),
      charter: charter(),
      executor: runtimeExecutor,
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
          generatorId: ROOT_GENERATOR_ID,
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
      states: [{
        key: "counter",
        schema: z.object({ count: z.number() }),
        init: { count: 0 },
      }],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const machine = createMachine({
      id: "inert-ingest-demo",
      instance: { id: "r", isSource: true, node: root },
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
    expect(resolveStates(machine.instance)[0]?.container.value).toEqual({ count: 1 });
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
        states: [counterState],
        tools: [updateCounter],
        runtime: {
          type: "generator",
          trigger: { type: "actor-frame" },
          boundaryProjection: "augment",
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
      instance: createRootInstance([instance]),
      charter: charter(),
      executor: runtimeExecutor,
    });

    await syncMachineRuntime(machine, {
      generatorId: ROOT_GENERATOR_ID,
      visibleFrames: [],
    });

    expect(machine.instance.states).toBeUndefined();
    expect(machine.instance.children?.[0]?.states?.counter?.value).toEqual({ count: 2 });
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
          boundaryProjection: "augment",
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
      instance: createRootInstance([instance]),
      charter: charter(),
      executor: runtimeExecutor,
    });

    await syncMachineRuntime(machine, {
      generatorId: ROOT_GENERATOR_ID,
      visibleFrames: [],
    });

    expect(instance.children?.map((item) => item.node.key)).toEqual(["child"]);
    expect(machine.frames[0]).toMatchObject({
      generatorId: ROOT_GENERATOR_ID,
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
      projection: { exposure: "deferred" } as const,
      scope: "local" as const,
    };
    const child = createNode({ key: "child" });
    const instance: Instance = {
      id: "r",
      isSource: true,
      node: createNode({
        key: "root",
        states: [state],
        runtime: {
          type: "generator",
          trigger: { type: "actor-frame" },
          boundaryProjection: "augment",
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
      instance: createRootInstance([instance]),
      charter: charter(),
      executor: runtimeExecutor,
    });

    await syncMachineRuntime(machine, {
      generatorId: ROOT_GENERATOR_ID,
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
          frames: [
            {
              messages: [
                {
                  type: "action" as const,
                  kind: "result" as const,
                  action: "tool" as const,
                  name: "trace",
                  callId: "trace-1",
                  success: true,
                  value: "ran",
                },
              ],
            },
          ],
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
      instance: { id: "r", isSource: true, node: root },
      charter: charter(),
      executor: runtimeExecutor,
    });
    machine.enqueueFrame({ messages: [{ ...textUserMessage("hi") }] });

    const frames = await collectFrames(runMachine(machine));

    expect(frames.map((frame) => frame.messages[0])).toMatchObject([
      { ...textUserMessage("hi") },
      { type: "work", kind: "activation" },
      { type: "action", kind: "result", action: "tool", name: "trace", callId: "trace-1", success: true, value: "ran" },
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
    });
    expect(frames[3]).toMatchObject({
      generatorId: "instance:r",
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
      instance: { id: "r", isSource: true, node: root },
      charter: charter<StructuredDataContent>(),
      executor: runtimeExecutor,
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
  it("serializes default projections by omission", () => {
    const node = createNode({
      key: "generator",
      runtime: { type: "generator", trigger: { type: "spawn" } },
    });

    const serialized = serializeNode(node, charter());

    expect(typeof serialized).toBe("object");
    if (typeof serialized === "string") {
      throw new Error("Expected inline serialized node");
    }
    expect(serialized).toMatchObject({
      key: "generator",
      runtime: {
        type: "generator",
        trigger: { type: "spawn" },
      },
    });
    expect(serialized.runtime?.type === "generator" ? serialized.runtime.boundaryProjection : undefined).toBeUndefined();
  });

  it("round-trips an augment boundary projection literal", () => {
    const source = createNode({
      key: "source",
      runtime: {
        type: "generator",
        trigger: { type: "spawn" },
        boundaryProjection: "augment",
      },
    });
    const derived = createNode({
      key: "source",
      sourceNodeKey: "source",
      runtime: {
        type: "generator",
        trigger: { type: "spawn" },
        boundaryProjection: "augment",
      },
    });
    const registry = charter({ nodes: [source] });

    const serialized = serializeNode(derived, registry);
    const hydrated = hydrateNode(serialized, registry);

    expect(typeof serialized).toBe("object");
    if (typeof serialized === "string") {
      throw new Error("Expected inline serialized node");
    }
    expect(serialized.runtime?.type === "generator" ? serialized.runtime.boundaryProjection : undefined).toBe(
      "augment",
    );
    expect(hydrated.runtime.type === "generator" ? hydrated.runtime.boundaryProjection : undefined).toBe(
      "augment",
    );
  });

  it("hydrates location-aware plain refs and rejects unknown refs", () => {
    const tool: Action = { state: null, name: "search" };
    const node = createNode({ key: "agent", tools: [tool] });
    const registry = charter({ nodes: [node], tools: [tool] });

    expect(hydrateNode("agent", registry)).toBe(node);
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
        parts: [
          { kind: "action", caller: "generator", ref: "search" },
          { kind: "action", caller: "external", ref: "approve" },
        ],
      },
      registry,
    );

    expect(hydrated.parts).toEqual([
      { kind: "action", caller: "generator", action: search },
      { kind: "action", caller: "external", action: approve },
    ]);
    expect(() =>
      hydrateNode({ key: "missingTool", parts: [{ kind: "action", caller: "generator", ref: "missing" }] }, registry),
    ).toThrow(/Unknown action ref "missing" for node hydration/);
    expect(() =>
      hydrateNode({ key: "missingCommand", parts: [{ kind: "action", caller: "external", ref: "missing" }] }, registry),
    ).toThrow(/Unknown action ref "missing" for node hydration/);
  });

  it("rejects duplicate charter action refs", () => {
    const first: Action = { state: null, name: "search", description: "first" };
    const second: Action = { state: null, name: "search", description: "second" };

    expect(() => charter({ tools: [first], commands: [second] })).toThrow(
      /Duplicate action ref "search"/,
    );
  });

  it("serializes registered states by ref, inline states by schema, and keeps members out of durable children", () => {
    const registeredState = createNode({
      key: "registeredState",
      states: [{ key: "thread", schema: z.object({ title: z.string() }), init: { title: "x" } }],
    }).states[0]!;
    const member = createNode({ key: "member" });
    const inline = createNode({
      key: "inline",
      members: [member],
      states: [{ key: "count", schema: z.number(), init: 1 }],
    });
    const registered = createNode({ key: "registered", states: [registeredState] });
    const registry = charter({ states: [registeredState], nodes: [registered] });

    expect(serializeStateDescriptor(registeredState, registry)).toBe("thread");

    const serializedInline = serializeInstance({ id: "i", isSource: true, node: inline }, registry);
    expect(typeof serializedInline.node).not.toBe("string");
    if (typeof serializedInline.node !== "string") {
      expect(serializedInline.children).toBeUndefined();
      expect(serializedInline.node.members?.map((item) =>
        typeof item === "string" ? item : "key" in item ? item.key : undefined
      )).toEqual(["member"]);
      expect(serializedInline.node.states?.[0]).toMatchObject({ key: "count" });
      const hydratedState = hydrateStateDescriptor(serializedInline.node.states![0]!, registry);
      expect(hydratedState.schema.parse(3)).toBe(3);
    }

    const serializedRegistered = serializeInstance({ id: "r", isSource: true, node: registered }, registry);
    expect(serializedRegistered.node).toBe("registered");

    const hydratedInline = hydrateInstance(serializedInline, registry);
    expect(hydratedInline.node.states[0]?.schema.parse(4)).toBe(4);
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
