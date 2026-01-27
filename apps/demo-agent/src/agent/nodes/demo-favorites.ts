import { z } from "zod";
import { createNode, createTransition, cede, type ToolDefinition } from "markov-machines";
import { themePack } from "../packs/theme.js";

export const demoFavoritesStateValidator = z.object({
  airplane: z.string().optional(),
  ungulate: z.string().optional(),
  mathematician: z.string().optional(),
});

export type DemoFavoritesState = z.infer<typeof demoFavoritesStateValidator>;

const updateFavorite: ToolDefinition<
  { category: "airplane" | "ungulate" | "mathematician"; value: string },
  string,
  DemoFavoritesState
> = {
  name: "updateFavorite",
  description: "Update one of the user's favorite things",
  inputSchema: z.object({
    category: z.enum(["airplane", "ungulate", "mathematician"]).describe("Which category to update"),
    value: z.string().describe("The user's favorite in this category"),
  }),
  execute: (input, ctx) => {
    ctx.updateState({ [input.category]: input.value });
    return `Updated favorite ${input.category}: ${input.value}`;
  },
};

export const demoFavoritesNode = createNode({
  name: "favorites",
  instructions: `You are demonstrating Node State in markov-machines.

Each node can have its own typed state that's validated by Zod.
Your state tracks the user's favorites in three categories:
- airplane: Their favorite airplane
- ungulate: Their favorite hooved mammal
- mathematician: Their favorite mathematician

Your job is to conversationally extract these favorites from the user.
Ask about them one at a time in a natural way. Use the updateFavorite tool to record their answers.

Watch the State tab on the right side - it updates in real-time as you collect answers!

Once you've collected all three (or the user wants to stop), use returnToFoo with a nice summary.`,

  validator: demoFavoritesStateValidator,
  packs: [themePack],
  tools: {
    updateFavorite,
  },
  transitions: {
    returnToFoo: createTransition<DemoFavoritesState>({
      description: "Return to the main Foo node with a summary of collected favorites",
      execute: (state) => {
        const collected: string[] = [];
        if (state.airplane) collected.push(`airplane: ${state.airplane}`);
        if (state.ungulate) collected.push(`ungulate: ${state.ungulate}`);
        if (state.mathematician) collected.push(`mathematician: ${state.mathematician}`);

        const summary = collected.length > 0
          ? `Favorites collected: ${collected.join(", ")}`
          : "No favorites collected this time.";

        return cede(summary);
      },
    }),
  },
  initialState: {
    airplane: undefined,
    ungulate: undefined,
    mathematician: undefined,
  },
});
