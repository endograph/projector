import type { Pack, PackConfig } from "../types/pack.js";

/**
 * Create a new pack definition.
 *
 * @example
 * const planPack = createPack({
 *   name: "plan",
 *   description: "Track a multi-step plan",
 *   validator: z.object({
 *     steps: z.array(z.object({ id: z.string(), status: z.string() })),
 *   }),
 *   tools: {
 *     addStep: {
 *       name: "addStep",
 *       description: "Add a step to the plan",
 *       inputSchema: z.object({ description: z.string() }),
 *       execute: (input, ctx) => {
 *         ctx.updateState({ steps: [...ctx.state.steps, { id: "...", status: "pending" }] });
 *         return "Step added";
 *       },
 *     },
 *   },
 *   initialState: { steps: [] },
 * });
 */
export function createPack<S>(config: PackConfig<S>): Pack<S> {
  return {
    name: config.name,
    description: config.description,
    validator: config.validator,
    tools: config.tools ?? {},
    initialState: config.initialState,
  };
}
