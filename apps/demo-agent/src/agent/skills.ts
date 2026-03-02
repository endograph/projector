// @NOTE this file and markov-skills in general is not yet integrated into the demo-agent
import {
  SkillRegistry,
  DiskSkillLoader,
  GitHubSkillLoader,
  MemorySkillLoader,
} from "markov-skills";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Create a skill registry for a session.
 * This is called per-session to allow session-specific skill configuration.
 */
export async function createSessionRegistry(): Promise<SkillRegistry> {
  // Create registry with available loaders
  const registry = new SkillRegistry({
    loaders: [
      new DiskSkillLoader(),
      new GitHubSkillLoader(),
      new MemorySkillLoader(),
    ],
  });

  // Register developer-provided skills from disk
  const skillsPath = join(__dirname, "../../skills");
  try {
    await registry.registerFromDisk(skillsPath);
  } catch {
    // Skills directory may not exist in all deployments
  }

  return registry;
}
