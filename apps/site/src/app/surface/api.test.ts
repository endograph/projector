import { describe, expect, it, vi } from "vitest";
import { createSurfaceApi } from "./api";

describe("surface api command feedback", () => {
  it("reports rejected state updates and preserves the rejection", async () => {
    const onStateUpdateRejected = vi.fn();
    const input = {
      address: { instanceId: "counter", stateKey: "count" },
      op: "replace",
      value: "not a number",
    };
    const effigy = {
      getInstances: () => null,
      subscribe: () => () => {},
      getCommand: () => ({
        run: vi.fn().mockResolvedValue({ success: false, error: "count must be a number" }),
      }),
    } as never;
    const api = createSurfaceApi(effigy, { onStateUpdateRejected });

    await expect(api.run("updateState", input)).rejects.toThrow("count must be a number");
    expect(onStateUpdateRejected).toHaveBeenCalledWith({
      error: expect.objectContaining({ message: "count must be a number" }),
      input,
    });
  });

  it("does not turn unrelated command failures into state notices", async () => {
    const onStateUpdateRejected = vi.fn();
    const effigy = {
      getInstances: () => null,
      subscribe: () => () => {},
      getCommand: () => ({ run: vi.fn().mockRejectedValue(new Error("failed")) }),
    } as never;
    const api = createSurfaceApi(effigy, { onStateUpdateRejected });

    await expect(api.run("appPanePing", {})).rejects.toThrow("failed");
    expect(onStateUpdateRejected).not.toHaveBeenCalled();
  });
});
