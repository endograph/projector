import { z } from "zod";
import { createNode, createTransition, transitionTo } from "markov-machines";
import { fooNode } from "./foo.js";

export const nameGateStateValidator = z.object({});

export type NameGateState = z.infer<typeof nameGateStateValidator>;

export const nameGateNode = createNode({
  instructions: `Ask: "Who do you want to talk to?"

Keep asking this exact question until the user provides a name. Do not explain anything else.

Once they give a name, use the toFoo transition with that name.`,

  validator: nameGateStateValidator,
  transitions: {
    toFoo: createTransition<NameGateState>({
      description: "Transition to the Foo node with the given name",
      arguments: z.object({
        name: z.string().describe("The name the user wants to talk to"),
      }),
      execute: (_state, ctx) => {
        const args = ctx.args as { name: string };
        return transitionTo(fooNode, { name: args.name });
      },
    }),
  },
  initialState: {},
});
