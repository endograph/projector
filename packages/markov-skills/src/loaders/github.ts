import type { SkillLoader, SkillSource, SkillContent } from "../types.js";
import { parseSkillMd } from "../parser.js";

type GitHubSource = Extract<SkillSource, { type: "github" }>;

/**
 * Loader for skills hosted on GitHub.
 * Fetches SKILL.md from raw.githubusercontent.com with in-memory caching.
 */
export class GitHubSkillLoader implements SkillLoader {
  private cache = new Map<string, { content: string; fetchedAt: number }>();

  canLoad(source: SkillSource): source is GitHubSource {
    return source.type === "github";
  }

  async load(source: SkillSource): Promise<SkillContent> {
    if (source.type !== "github") {
      throw new Error("GitHubSkillLoader can only load github sources");
    }

    const { owner, repo, ref = "main", path = "" } = source;
    const key = `${owner}/${repo}/${ref}/${path}`;

    // Check cache (no TTL - cache for session duration)
    const cached = this.cache.get(key);
    if (cached) {
      return cached.content;
    }

    // Build raw GitHub URL
    const skillPath = path ? `${path}/SKILL.md` : "SKILL.md";
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${skillPath}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch skill from GitHub: ${response.status} ${response.statusText}`
      );
    }

    const raw = await response.text();
    const { content } = parseSkillMd(raw);

    this.cache.set(key, { content, fetchedAt: Date.now() });
    return content;
  }

  /**
   * Clear the fetch cache.
   */
  clearCache(): void {
    this.cache.clear();
  }
}
