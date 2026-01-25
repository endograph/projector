import { z } from "zod";
import { createNode, createTransition, spawn, cede } from "markov-machines";
import { demoMemoryNode } from "./demo-memory";
import { demoPingNode } from "./demo-ping";
import { demoFavoritesNode } from "./demo-favorites";
import { themePack } from "../packs/theme";

export const fooStateValidator = z.object({
  name: z.string(),
});

export type FooState = z.infer<typeof fooStateValidator>;

export const fooNode = createNode({
  instructions: `You guide the markov-machines demo. Your name is in your state - greet the user with it when you first become active.

Three demos available:
1. Memory Demo - Pack system, persistent key-value storage
2. Ping Demo - Commands that bypass the LLM
3. Favorites Demo - Node State with real-time updates

Spawn the appropriate demo node when requested. When a child cedes back, you receive their summary.`,

  validator: fooStateValidator,
  packs: [themePack],
  transitions: {
    spawnMemoryDemo: createTransition<FooState>({
      description: "Spawn the Memory Demo node to showcase the Pack system",
      execute: () => spawn(demoMemoryNode, {}),
    }),
    spawnPingDemo: createTransition<FooState>({
      description: "Spawn the Ping Demo node to showcase Commands",
      execute: () => spawn(demoPingNode, {}),
    }),
    spawnFavoritesDemo: createTransition<FooState>({
      description: "Spawn the Favorites Demo node to showcase Node State",
      execute: () =>
        spawn(demoFavoritesNode, {
          airplane: undefined,
          ungulate: undefined,
          mathematician: undefined,
        }),
    }),
    cedeToParent: createTransition<FooState>({
      description: "Say goodbye and cede back to the root node",
      execute: (state) => cede(`${state.name} says goodbye!`),
    }),
  },
  initialState: { name: "" },
});
