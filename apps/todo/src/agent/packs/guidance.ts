import { z } from "zod";
import { createPack } from "markov-machines";

/**
 * Guidance pack - stores evergreen user preferences and guidance.
 * Key-value store that persists across sessions.
 */

const guidanceStateValidator = z.object({
  entries: z.record(z.string(), z.string()),
});

export type GuidanceState = z.infer<typeof guidanceStateValidator>;

export const guidancePack = createPack({
  name: "guidance",
  description: "Evergreen guidance and preferences. Reference when making decisions or recommendations.",
  validator: guidanceStateValidator,
  tools: {
    setGuidance: {
      name: "setGuidance",
      description: "Store evergreen guidance (key-value pair). Use for preferences that should persist.",
      inputSchema: z.object({
        key: z.string().describe("Short key for this guidance (e.g., 'products', 'budget', 'style')"),
        value: z.string().describe("The guidance value"),
      }),
      execute: (input, ctx) => {
        ctx.updateState({
          entries: { ...ctx.state.entries, [input.key]: input.value },
        });
        return `Guidance saved: ${input.key} = "${input.value}"`;
      },
    },
    removeGuidance: {
      name: "removeGuidance",
      description: "Remove a guidance entry by key",
      inputSchema: z.object({
        key: z.string().describe("The key to remove"),
      }),
      execute: (input, ctx) => {
        const { [input.key]: removed, ...rest } = ctx.state.entries;
        if (removed === undefined) {
          return `No guidance found for key: ${input.key}`;
        }
        ctx.updateState({ entries: rest });
        return `Removed guidance: ${input.key}`;
      },
    },
  },
  initialState: { entries: {} },
});
