import { describe, expect, test } from "vitest";
import { readAppSurfaceSelection } from "./artifacts";

describe("app surface artifact selection", () => {
  test("uses the explicit active version from a nested app surface state", () => {
    expect(
      readAppSurfaceSelection({
        children: [
          {
            states: {
              appSurface: { value: { version: 4, activeVersion: 2 } },
            },
          },
        ],
      }),
    ).toEqual({ latestVersion: 4, activeVersion: 2 });
  });

  test("treats the latest version as active for existing snapshots", () => {
    expect(
      readAppSurfaceSelection({
        states: { appSurface: { value: { version: 3 } } },
      }),
    ).toEqual({ latestVersion: 3, activeVersion: 3 });
  });
});
