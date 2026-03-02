import { describe, expect, it, beforeEach } from "vitest";
import { createSkillsPack } from "../pack.js";
import { SkillRegistry } from "../registry.js";
import { MemorySkillLoader } from "../loaders/memory.js";

describe("createSkillsPack", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry({ loaders: [new MemorySkillLoader()] });
  });

  it("creates a pack with name 'skills'", () => {
    const pack = createSkillsPack(registry);
    expect(pack.name).toBe("skills");
  });

  it("includes description", () => {
    const pack = createSkillsPack(registry);
    expect(pack.description).toContain("skills");
  });

  it("has empty initial state", () => {
    const pack = createSkillsPack(registry);
    expect(pack.initialState).toEqual({});
  });

  describe("instructions", () => {
    it("generates dynamic instructions listing available skills", () => {
      registry.register({
        name: "git",
        description: "Git repository operations",
        source: { type: "memory", content: "Git instructions" },
      });
      registry.register({
        name: "docker",
        description: "Container management",
        source: { type: "memory", content: "Docker instructions" },
      });

      const pack = createSkillsPack(registry);
      const instructions =
        typeof pack.instructions === "function"
          ? pack.instructions({})
          : pack.instructions;

      expect(instructions).toContain("git");
      expect(instructions).toContain("Git repository operations");
      expect(instructions).toContain("docker");
      expect(instructions).toContain("Container management");
      expect(instructions).toContain("useSkill");
    });

    it("shows no skills message when registry is empty", () => {
      const pack = createSkillsPack(registry);
      const instructions =
        typeof pack.instructions === "function"
          ? pack.instructions({})
          : pack.instructions;

      expect(instructions).toContain("No skills available");
    });
  });

  describe("useSkill tool", () => {
    it("has useSkill tool defined", () => {
      const pack = createSkillsPack(registry);
      expect(pack.tools).toHaveProperty("useSkill");
    });

    it("useSkill returns skill content on success", async () => {
      registry.register({
        name: "test-skill",
        description: "A test skill",
        source: { type: "memory", content: "# Test Skill\n\nDo the thing." },
      });

      const pack = createSkillsPack(registry);
      const tool = pack.tools.useSkill;

      const result = await tool.execute(
        { name: "test-skill" },
        { state: {}, updateState: () => {} }
      );

      expect(result).toContain("# Skill: test-skill");
      expect(result).toContain("# Test Skill");
      expect(result).toContain("Do the thing.");
      expect(result).toContain("Follow these instructions");
    });

    it("useSkill returns error message when skill not found", async () => {
      const pack = createSkillsPack(registry);
      const tool = pack.tools.useSkill;

      const result = await tool.execute(
        { name: "nonexistent" },
        { state: {}, updateState: () => {} }
      );

      expect(result).toContain("Failed to load skill");
      expect(result).toContain("nonexistent");
    });
  });
});
