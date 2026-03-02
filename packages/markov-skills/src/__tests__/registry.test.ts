import { describe, expect, it, beforeEach } from "vitest";
import { SkillRegistry } from "../registry.js";
import { MemorySkillLoader } from "../loaders/memory.js";
import type { SkillManifest } from "../types.js";

describe("SkillRegistry", () => {
  let registry: SkillRegistry;
  let memoryLoader: MemorySkillLoader;

  beforeEach(() => {
    memoryLoader = new MemorySkillLoader();
    registry = new SkillRegistry({ loaders: [memoryLoader] });
  });

  describe("register", () => {
    it("registers a skill manifest", () => {
      const manifest: SkillManifest = {
        name: "test-skill",
        description: "A test skill",
        source: { type: "memory", content: "Test content" },
      };

      registry.register(manifest);

      expect(registry.getManifest("test-skill")).toEqual(manifest);
    });

    it("overwrites existing manifest with same name", () => {
      const manifest1: SkillManifest = {
        name: "test",
        description: "First",
        source: { type: "memory", content: "Content 1" },
      };
      const manifest2: SkillManifest = {
        name: "test",
        description: "Second",
        source: { type: "memory", content: "Content 2" },
      };

      registry.register(manifest1);
      registry.register(manifest2);

      expect(registry.getManifest("test")?.description).toBe("Second");
    });
  });

  describe("registerAll", () => {
    it("registers multiple manifests at once", () => {
      const manifests: SkillManifest[] = [
        { name: "skill-1", description: "Skill 1", source: { type: "memory", content: "1" } },
        { name: "skill-2", description: "Skill 2", source: { type: "memory", content: "2" } },
      ];

      registry.registerAll(manifests);

      expect(registry.getSkillNames()).toContain("skill-1");
      expect(registry.getSkillNames()).toContain("skill-2");
    });
  });

  describe("getSkillNames", () => {
    it("returns empty array when no skills registered", () => {
      expect(registry.getSkillNames()).toEqual([]);
    });

    it("returns all registered skill names", () => {
      registry.register({
        name: "alpha",
        description: "A",
        source: { type: "memory", content: "a" },
      });
      registry.register({
        name: "beta",
        description: "B",
        source: { type: "memory", content: "b" },
      });

      const names = registry.getSkillNames();
      expect(names).toContain("alpha");
      expect(names).toContain("beta");
    });
  });

  describe("listDescriptions", () => {
    it("returns message when no skills available", () => {
      expect(registry.listDescriptions()).toBe("No skills available.");
    });

    it("formats skill descriptions as markdown list", () => {
      registry.register({
        name: "git",
        description: "Git operations",
        source: { type: "memory", content: "" },
      });
      registry.register({
        name: "docker",
        description: "Docker management",
        source: { type: "memory", content: "" },
      });

      const list = registry.listDescriptions();

      expect(list).toContain("- **git**: Git operations");
      expect(list).toContain("- **docker**: Docker management");
    });
  });

  describe("loadSkill", () => {
    it("loads skill content from memory source", async () => {
      registry.register({
        name: "test",
        description: "Test",
        source: { type: "memory", content: "Hello, World!" },
      });

      const content = await registry.loadSkill("test");

      expect(content).toBe("Hello, World!");
    });

    it("caches loaded content", async () => {
      registry.register({
        name: "cached",
        description: "Test",
        source: { type: "memory", content: "Cached content" },
      });

      await registry.loadSkill("cached");
      expect(registry.isCached("cached")).toBe(true);

      // Load again - should use cache
      const content = await registry.loadSkill("cached");
      expect(content).toBe("Cached content");
    });

    it("throws when skill not found", async () => {
      await expect(registry.loadSkill("nonexistent")).rejects.toThrow(
        "Skill not found: nonexistent"
      );
    });

    it("throws when no loader available for source type", async () => {
      // Create registry with no loaders
      const emptyRegistry = new SkillRegistry({ loaders: [] });
      emptyRegistry.register({
        name: "disk-skill",
        description: "Test",
        source: { type: "disk", path: "/some/path" },
      });

      await expect(emptyRegistry.loadSkill("disk-skill")).rejects.toThrow(
        "No loader available for source type: disk"
      );
    });
  });

  describe("isCached", () => {
    it("returns false for uncached skills", () => {
      registry.register({
        name: "test",
        description: "Test",
        source: { type: "memory", content: "Content" },
      });

      expect(registry.isCached("test")).toBe(false);
    });

    it("returns true after skill is loaded", async () => {
      registry.register({
        name: "test",
        description: "Test",
        source: { type: "memory", content: "Content" },
      });

      await registry.loadSkill("test");

      expect(registry.isCached("test")).toBe(true);
    });
  });

  describe("clearCache", () => {
    it("clears cached content but keeps manifests", async () => {
      registry.register({
        name: "test",
        description: "Test",
        source: { type: "memory", content: "Content" },
      });

      await registry.loadSkill("test");
      expect(registry.isCached("test")).toBe(true);

      registry.clearCache();

      expect(registry.isCached("test")).toBe(false);
      expect(registry.getManifest("test")).toBeDefined();
    });
  });
});
