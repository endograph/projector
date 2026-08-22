import { describe, expect, it } from "vitest";
import { escapeConvexJson, restoreConvexJson } from "./convexJson";

describe("Convex JSON encoding", () => {
  it("stores schema-bearing fields as strings and restores them losslessly", () => {
    let nestedSchema: Record<string, unknown> = { type: "number" };
    for (let depth = 0; depth < 25; depth += 1) {
      nestedSchema = {
        type: "object",
        properties: { value: nestedSchema },
      };
    }
    const value = {
      action: {
        stateSchema: {
          type: "object",
          properties: {
            snake: nestedSchema,
          },
        },
      },
      child: {
        states: [{ stateKey: "game", schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" } }],
      },
    };

    const escaped = escapeConvexJson(value) as typeof value;

    expect(typeof escaped.action.stateSchema).toBe("string");
    expect(typeof escaped.child.states[0]?.schema).toBe("string");
    expect(restoreConvexJson(escaped)).toEqual(value);
  });

  it("leaves ordinary objects structured", () => {
    const value = { state: { nested: { value: 1 } } };

    expect(escapeConvexJson(value)).toEqual(value);
  });
});
