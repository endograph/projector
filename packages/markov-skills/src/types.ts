/**
 * Skill manifest containing metadata about a skill.
 * The manifest is loaded at startup; full content is loaded lazily.
 */
export interface SkillManifest {
  /** Unique name identifier for the skill */
  name: string;
  /** Short description shown in system prompt for skill discovery */
  description: string;
  /** Where to load the full skill content from */
  source: SkillSource;
}

/**
 * Source configuration for loading skill content.
 */
export type SkillSource =
  | { type: "disk"; path: string }
  | { type: "github"; owner: string; repo: string; ref?: string; path?: string }
  | { type: "memory"; content: string }
  | { type: "anthropic-builtin"; builtinType: string };

/**
 * The full content of a skill (body text after YAML frontmatter).
 */
export type SkillContent = string;

/**
 * Interface for loading skill content from various sources.
 */
export interface SkillLoader {
  /** Check if this loader can handle the given source type */
  canLoad(source: SkillSource): boolean;
  /** Load full skill content from source */
  load(source: SkillSource): Promise<SkillContent>;
}

/**
 * Configuration for creating a SkillRegistry.
 */
export interface SkillRegistryConfig {
  /** Loaders to use for fetching skill content */
  loaders: SkillLoader[];
}

/**
 * Parsed SKILL.md file structure.
 */
export interface ParsedSkillMd {
  /** Frontmatter metadata (name, description) */
  frontmatter: {
    name?: string;
    description?: string;
  };
  /** Body content after frontmatter */
  content: string;
}
