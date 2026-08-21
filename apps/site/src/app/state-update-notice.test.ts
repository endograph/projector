import { describe, expect, it } from "vitest";
import { formatStateUpdateRejection } from "./state-update-notice";

describe("state update rejection notices", () => {
  it("formats structured validation issues with the state and failing path", () => {
    const error = new Error(JSON.stringify([
      {
        code: "invalid_value",
        values: ["R", "Y"],
        path: ["turn"],
        message: 'Invalid option: expected one of "R"|"Y"',
      },
    ], null, 2));

    expect(formatStateUpdateRejection(error, {
      address: { instanceId: "game", stateKey: "connectFour" },
    })).toBe('connectFour: turn: Invalid option: expected one of "R"|"Y"');
  });

  it("strips Convex wrappers from ordinary errors", () => {
    expect(formatStateUpdateRejection(
      new Error("[CONVEX M(sessions:sendCommand)] Uncaught ConvexError: count must be positive"),
      { address: "counter" },
    )).toBe("counter: count must be positive");
  });
});
