import { z } from "zod";
import { createNode, createTransition, cede, toolReply } from "markov-machines";
import { themePack } from "../packs/theme";

export const demoPingStateValidator = z.object({});

export type DemoPingState = z.infer<typeof demoPingStateValidator>;

export const demoPingNode = createNode({
  instructions: `You are demonstrating the Commands feature of markov-machines.

Commands are special operations that bypass the LLM entirely and execute instantly.
This is useful for:
- Fast operations that don't need AI reasoning
- Predictable responses (like health checks)
- User-initiated actions with known outcomes

Tell the user to try the "ping" command from the Commands tab on the right side.
When they execute it, they'll get an instant "pong" response without any LLM call!

Explain that this is great for:
- Quick status checks
- Direct state manipulations
- Any operation where you want deterministic behavior

When done demonstrating, use returnToFoo to go back.`,

  validator: demoPingStateValidator,
  packs: [themePack],
  commands: {
    ping: {
      name: "ping",
      description: "Returns pong instantly (bypasses LLM)",
      inputSchema: z.object({}),
      execute: () => toolReply("pong", "[User ran ping command]"),
    },
  },
  transitions: {
    returnToFoo: createTransition<DemoPingState>({
      description: "Return to the main Foo node after completing the ping demo",
      execute: () => cede("Ping demo complete! Commands bypass the LLM for instant responses."),
    }),
  },
  initialState: {},
});
