import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  applyInstanceMessage,
  createAction,
  createNode,
  createSourceInstance,
  createState,
  hydrateInstance,
  inspectCompiledProjectionTree,
  normalizeSchema,
  resolveStates,
  serializeInstance,
  type Instance,
} from "../../index.ts";
import { charter } from "./helpers.ts";

type Counter = { count: number };

const counterJsonSchema = {
  type: "object",
  properties: { count: { type: "number" } },
  required: ["count"],
  additionalProperties: false,
};

/** A hand-written Standard Schema (no library) that also converts to JSON Schema. */
const counterSchema: StandardSchemaV1<Counter> & StandardJSONSchemaV1<Counter> = {
  "~standard": {
    version: 1,
    vendor: "handwritten",
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as Counter).count === "number"
        ? { value: value as Counter }
        : { issues: [{ message: "expected a number", path: ["count"] }] },
    jsonSchema: {
      input: () => counterJsonSchema,
      output: () => counterJsonSchema,
    },
  },
};

describe("conformance: Standard Schema positions", () => {
  it("validates state updates through a non-zod schema", () => {
    const counter = createState({ key: "counter", schema: counterSchema, init: { count: 0 } });
    expectTypeOf(counter.init).toEqualTypeOf<Counter | (() => Counter) | undefined>();
    const node = createNode({ key: "root", states: [counter] });
    const root: Instance = { id: "r", isSource: true, node };
    const registry = charter({ nodes: [node], states: [counter] });

    applyInstanceMessage(
      root,
      { type: "instance", kind: "state.update", instanceId: "r", stateKey: "counter", update: { op: "replace", value: { count: 2 } } },
      registry,
    );
    expect(resolveStates(root).find((s) => s.address.stateKey === "counter")?.container.value).toEqual({ count: 2 });

    expect(() =>
      applyInstanceMessage(
        root,
        { type: "instance", kind: "state.update", instanceId: "r", stateKey: "counter", update: { op: "replace", value: { count: "two" } } },
        registry,
      ),
    ).toThrow(/expected a number \(at count\)/);
  });

  it("carries the schema's JSON Schema on the compiled tool surface", () => {
    const setCounter = createAction({
      state: null,
      name: "setCounter",
      inputSchema: counterSchema,
      run: (input) => {
        expectTypeOf(input).toEqualTypeOf<Counter>();
      },
    });
    const node = createNode({
      key: "root",
      tools: [setCounter],
      runtime: { type: "generator", trigger: { type: "actor-frame" } },
    });
    const tree = inspectCompiledProjectionTree(createSourceInstance({ id: "r", node }), {
      charter: charter({ nodes: [node] }),
    });

    const tools = tree.roots[0]!.compiled.tools;
    expect(tools.find((tool) => tool.name === "setCounter")?.inputSchema).toEqual(counterJsonSchema);
  });

  it("round-trips inline state and output schemas through serialization as JSON Schema", () => {
    const node = createNode({
      key: "inline",
      states: [{ key: "counter", schema: counterSchema, init: { count: 0 } }],
      output: { audience: "broadcast", schema: counterSchema },
    });
    const registry = charter();

    const serialized = serializeInstance({ id: "i", isSource: true, node }, registry);
    if (typeof serialized.node === "string") throw new Error("expected inline node");
    expect(serialized.node.output?.schema).toEqual(counterJsonSchema);

    const hydrated = hydrateInstance(JSON.parse(JSON.stringify(serialized)), registry);
    const state = normalizeSchema(hydrated.node.states[0]!.schema);
    expect(state.accepts({ count: 1 })).toBe(true);
    expect(state.accepts({ count: "one" })).toBe(false);
    expect(normalizeSchema(hydrated.node.output!.schema!).accepts({ count: 3 })).toBe(true);
  });

  it("rejects schemas that validate asynchronously or lack a JSON Schema source at creation", () => {
    const asyncSchema: StandardSchemaV1<Counter> = {
      "~standard": {
        version: 1,
        vendor: "handwritten",
        validate: async (value) => ({ value: value as Counter }),
      },
    };
    expect(() => createState({ key: "counter", schema: asyncSchema })).toThrow(/asynchronously/);

    const opaqueSchema: StandardSchemaV1<Counter> = {
      "~standard": { version: 1, vendor: "handwritten", validate: (value) => ({ value: value as Counter }) },
    };
    expect(() => createAction({ state: null, name: "opaque", inputSchema: opaqueSchema })).toThrow(
      /no JSON Schema source/,
    );
  });
});
