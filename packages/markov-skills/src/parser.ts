import type { ParsedSkillMd } from "./types.js";

/**
 * Parse a SKILL.md file with YAML frontmatter.
 *
 * Expected format:
 * ```
 * ---
 * name: skill-name
 * description: Short description
 * ---
 *
 * # Skill Content
 * ...
 * ```
 */
export function parseSkillMd(raw: string): ParsedSkillMd {
  const trimmed = raw.trim();

  // Check for frontmatter delimiter
  if (!trimmed.startsWith("---")) {
    return {
      frontmatter: {},
      content: trimmed,
    };
  }

  // Find the closing delimiter
  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) {
    return {
      frontmatter: {},
      content: trimmed,
    };
  }

  const frontmatterText = trimmed.slice(3, endIndex).trim();
  const content = trimmed.slice(endIndex + 3).trim();

  // Parse simple YAML (key: value pairs only)
  const frontmatter: ParsedSkillMd["frontmatter"] = {};
  for (const line of frontmatterText.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key === "name" || key === "description") {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, content };
}
