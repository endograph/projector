import { describe, expect, it } from "vitest";
import { MemorySkillLoader } from "../loaders/memory.js";
import type { SkillSource } from "../types.js";

describe("MemorySkillLoader", () => {
  const loader = new MemorySkillLoader();

  describe("canLoad", () => {
    it("returns true for memory sources", () => {
      const source: SkillSource = { type: "memory", content: "test" };
      expect(loader.canLoad(source)).toBe(true);
    });

    it("returns false for disk sources", () => {
      const source: SkillSource = { type: "disk", path: "/test" };
      expect(loader.canLoad(source)).toBe(false);
    });

    it("returns false for github sources", () => {
      const source: SkillSource = { type: "github", owner: "test", repo: "test" };
      expect(loader.canLoad(source)).toBe(false);
    });

    it("returns false for anthropic-builtin sources", () => {
      const source: SkillSource = { type: "anthropic-builtin", builtinType: "computer_use" };
      expect(loader.canLoad(source)).toBe(false);
    });
  });

  describe("load", () => {
    it("returns content from memory source", async () => {
      const source: SkillSource = { type: "memory", content: "Hello, World!" };
      const content = await loader.load(source);
      expect(content).toBe("Hello, World!");
    });

    it("throws for non-memory sources", async () => {
      const source: SkillSource = { type: "disk", path: "/test" };
      await expect(loader.load(source)).rejects.toThrow(
        "MemorySkillLoader can only load memory sources"
      );
    });

    it("handles empty content", async () => {
      const source: SkillSource = { type: "memory", content: "" };
      const content = await loader.load(source);
      expect(content).toBe("");
    });

    it("handles multiline content", async () => {
      const source: SkillSource = {
        type: "memory",
        content: "Line 1\nLine 2\nLine 3",
      };
      const content = await loader.load(source);
      expect(content).toBe("Line 1\nLine 2\nLine 3");
    });
  });
});
