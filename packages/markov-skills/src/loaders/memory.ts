import type { SkillLoader, SkillSource, SkillContent } from "../types.js";

type MemorySource = Extract<SkillSource, { type: "memory" }>;

/**
 * Loader for skills with pre-loaded content in memory.
 * Useful for bundled skills or testing.
 */
export class MemorySkillLoader implements SkillLoader {
  canLoad(source: SkillSource): source is MemorySource {
    return source.type === "memory";
  }

  async load(source: SkillSource): Promise<SkillContent> {
    if (source.type !== "memory") {
      throw new Error("MemorySkillLoader can only load memory sources");
    }
    return source.content;
  }
}
