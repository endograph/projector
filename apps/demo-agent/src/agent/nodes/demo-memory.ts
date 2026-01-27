import { z } from "zod";
import { createNode, createTransition, cede } from "markov-machines";
import { memoryPack } from "../packs/memory.js";
import { themePack } from "../packs/theme.js";

export const demoMemoryStateValidator = z.object({});

export type DemoMemoryState = z.infer<typeof demoMemoryStateValidator>;

export const demoMemoryNode = createNode({
  name: "favorites",
  instructions: `You are demonstrating the Memory Pack feature of markov-machines.

The Memory Pack provides persistent key-value storage that lives in the machine's state.
Any memories stored here will persist across the conversation and can be accessed by any node that uses the memory pack.

Encourage the user to:
- Store important memories they never want to forget
- Try setting, getting, and listing memories
- Understand that these memories persist in the machine state

Be enthusiastic and helpful! When done, use returnToFoo to go back.`,

  validator: demoMemoryStateValidator,
  packs: [memoryPack, themePack],
  transitions: {
    returnToFoo: createTransition<DemoMemoryState>({
      description: "Return to the main Foo node after completing the memory demo",
      execute: () => cede("Memory demo complete! You can see the stored memories in the State tab."),
    }),
  },
  initialState: {},
});
