import type {
  SkillManifest,
  SkillContent,
  SkillLoader,
  SkillRegistryConfig,
  SkillSource,
} from "./types.js";
import { parseSkillMd } from "./parser.js";

/**
 * Registry for managing skill manifests and lazy-loading skill content.
 *
 * Skills are registered at startup with their manifests (lightweight metadata).
 * Full content is loaded on-demand via loaders and cached for the session.
 */
export class SkillRegistry {
  private manifests = new Map<string, SkillManifest>();
  private cache = new Map<string, SkillContent>();
  private loaders: SkillLoader[];

  constructor(config: SkillRegistryConfig) {
    this.loaders = config.loaders;
  }

  /**
   * Register a skill manifest.
   */
  register(manifest: SkillManifest): void {
    this.manifests.set(manifest.name, manifest);
  }

  /**
   * Register multiple skill manifests at once.
   */
  registerAll(manifests: SkillManifest[]): void {
    for (const manifest of manifests) {
      this.register(manifest);
    }
  }

  /**
   * Get a skill manifest by name.
   */
  getManifest(name: string): SkillManifest | undefined {
    return this.manifests.get(name);
  }

  /**
   * Get all registered skill names.
   */
  getSkillNames(): string[] {
    return Array.from(this.manifests.keys());
  }

  /**
   * Generate a formatted list of skill descriptions for the system prompt.
   */
  listDescriptions(): string {
    const entries = Array.from(this.manifests.values());
    if (entries.length === 0) {
      return "No skills available.";
    }
    return entries
      .map((m) => `- **${m.name}**: ${m.description}`)
      .join("\n");
  }

  /**
   * Load full skill content by name.
   * Content is cached for the session after first load.
   */
  async loadSkill(name: string): Promise<SkillContent> {
    // Check cache first
    const cached = this.cache.get(name);
    if (cached !== undefined) {
      return cached;
    }

    // Get manifest
    const manifest = this.manifests.get(name);
    if (!manifest) {
      throw new Error(`Skill not found: ${name}`);
    }

    // Handle memory source (content already available)
    if (manifest.source.type === "memory") {
      const content = manifest.source.content;
      this.cache.set(name, content);
      return content;
    }

    // Find a loader that can handle this source
    const loader = this.loaders.find((l) => l.canLoad(manifest.source));
    if (!loader) {
      throw new Error(
        `No loader available for source type: ${manifest.source.type}`
      );
    }

    // Load and cache
    const content = await loader.load(manifest.source);
    this.cache.set(name, content);
    return content;
  }

  /**
   * Check if a skill's content is already cached.
   */
  isCached(name: string): boolean {
    return this.cache.has(name);
  }

  /**
   * Clear the content cache (manifests remain registered).
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Register skills from a directory containing SKILL.md files.
   * Each subdirectory is expected to contain a SKILL.md file.
   */
  async registerFromDisk(
    basePath: string,
    diskLoader?: SkillLoader
  ): Promise<void> {
    // Dynamic import for file system access
    const fs = await import("fs/promises");
    const path = await import("path");

    const entries = await fs.readdir(basePath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = path.join(basePath, entry.name, "SKILL.md");

      try {
        const raw = await fs.readFile(skillPath, "utf-8");
        const { frontmatter, content } = parseSkillMd(raw);

        const name = frontmatter.name ?? entry.name;
        const description = frontmatter.description ?? `Skill: ${name}`;

        this.register({
          name,
          description,
          source: { type: "disk", path: skillPath },
        });

        // Pre-cache the content since we already read it
        this.cache.set(name, content);
      } catch {
        // Skip directories without valid SKILL.md
        continue;
      }
    }
  }
}
