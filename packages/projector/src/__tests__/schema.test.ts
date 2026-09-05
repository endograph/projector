import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  createAction,
  createCharter,
  createMachine,
  createNode,
  createState,
  executeCommand,
  normalizeSchema,
  schemaFromJsonSchema,
  type Schema,
} from "../../index.ts";

describe("validation-only schema contract", () => {
  it("validates the canonical input JSON Schema without applying source coercions", () => {
    // Runtime callers can bypass authoring types (plain JS, hydrated data), so
    // canonical validation must still ignore source coercion behavior.
    const schema = normalizeSchema(z.coerce.number() as unknown as Schema<number>);

    expect(schema.accepts(42)).toBe(true);
    expect(schema.accepts("42")).toBe(false);

    const hydrated = normalizeSchema(
      schemaFromJsonSchema<number>(schema.jsonSchema()),
    );
    expect(hydrated.accepts(42)).toBe(true);
    expect(hydrated.accepts("42")).toBe(false);
  });

  it("passes the original validated value to actions", async () => {
    let observed: string | undefined;
    const command = createAction({
      state: null,
      name: "echo",
      inputSchema: z.string().trim(),
      run: (input) => {
        observed = input;
        return input;
      },
    });
    const node = createNode({ key: "root", commands: [command] });
    const charter = createCharter({ nodes: [node], commands: [command] });
    const machine = createMachine({
      instance: { id: "root", isSource: true, node },
      charter,
    });

    const result = await executeCommand(machine, {
      type: "action",
      kind: "request",
      action: "command",
      name: "echo",
      input: "  unchanged  ",
      callId: "echo-1",
    });

    expect(result).toMatchObject({ success: true, value: "  unchanged  " });
    expect(observed).toBe("  unchanged  ");
  });

  it("exposes one JSON Schema with no input/output switch", () => {
    const schema = normalizeSchema(z.string());
    expect(schema.jsonSchema()).toMatchObject({ type: "string" });

    if (false) {
      // @ts-expect-error Projector has one canonical JSON Schema, not separate IO forms.
      schema.jsonSchema({ io: "output" });
    }
  });

  it("rejects schemas whose declared input and output types differ", () => {
    if (false) {
      // @ts-expect-error Canonical schemas cannot coerce unknown input into a number.
      normalizeSchema(z.coerce.number());

      createAction({
        state: null,
        name: "length",
        // @ts-expect-error Projector action schemas cannot transform their input type.
        inputSchema: z.string().transform((value) => value.length),
        run: () => undefined,
      });

      // @ts-expect-error Projector state schemas cannot transform their input type.
      createState({
        key: "count",
        schema: z.string().transform((value) => value.length),
        init: "0",
      });

      createNode({
        key: "transforming-output",
        // @ts-expect-error Projector output schemas cannot transform their input type.
        output: { schema: z.string().transform((value) => value.length) },
      });
    }
  });
});
