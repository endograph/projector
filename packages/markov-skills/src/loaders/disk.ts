import type { SkillLoader, SkillSource, SkillContent } from "../types.js";
import { parseSkillMd } from "../parser.js";

type DiskSource = Extract<SkillSource, { type: "disk" }>;

/**
 * Loader for skills stored on the local filesystem.
 */
export class DiskSkillLoader implements SkillLoader {
  canLoad(source: SkillSource): source is DiskSource {
    return source.type === "disk";
  }

  async load(source: SkillSource): Promise<SkillContent> {
    if (source.type !== "disk") {
      throw new Error("DiskSkillLoader can only load disk sources");
    }

    const fs = await import("fs/promises");
    const raw = await fs.readFile(source.path, "utf-8");
    const { content } = parseSkillMd(raw);
    return content;
  }
}
