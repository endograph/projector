import { z } from "zod";
import { createPack, type Pack } from "markov-machines";
import type { SkillRegistry } from "./registry.js";

/**
 * Create a skills pack that provides lazy-loading skill discovery and usage.
 *
 * The pack adds skill descriptions to the system prompt and provides a
 * `useSkill` tool for the agent to load full skill instructions on demand.
 */
export function createSkillsPack(registry: SkillRegistry): Pack<{}> {
  return createPack({
    name: "skills",
    description: "Available skills that can be loaded on demand",
    validator: z.object({}),
    initialState: {},

    // Dynamic instructions list available skills
    instructions: () => {
      const descriptions = registry.listDescriptions();
      return `## Available Skills

The following skills are available. Use the \`useSkill\` tool to load a skill's full instructions when you need it.

${descriptions}

When a user's request matches a skill's description, load and follow that skill's instructions.`;
    },

    tools: {
      useSkill: {
        name: "useSkill",
        description:
          "Load a skill's full instructions. Call this when you need to use a skill.",
        inputSchema: z.object({
          name: z.string().describe("The skill name to load"),
        }),
        execute: async ({ name }) => {
          try {
            const content = await registry.loadSkill(name);
            return `# Skill: ${name}\n\n${content}\n\n---\nFollow these instructions to complete the user's request.`;
          } catch (e) {
            return `Failed to load skill "${name}": ${(e as Error).message}`;
          }
        },
      },
    },
  });
}
