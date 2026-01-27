/**
 * @markov-machines/livekit-executor
 *
 * An executor for markov-machines that delegates voice inference to LiveKit agents.
 *
 * Usage:
 * ```ts
 * import { LiveKitExecutor } from "@markov-machines/livekit-executor";
 * import { createCharter, createMachine, runMachine } from "markov-machines";
 *
 * const executor = new LiveKitExecutor({ debug: true });
 * const charter = createCharter({ executor, nodes: {...}, transitions: {...} });
 * const machine = createMachine(charter, { instance: createInstance(rootNode, initialState) });
 *
 * // In your LiveKit agent entry function:
 * await executor.connect(machine, { session, room: ctx.room });
 *
 * // Run the machine loop - yields steps as LiveKit events come in
 * for await (const step of runMachine(machine)) {
 *   await saveToDatabase(step);
 * }
 * ```
 */

export { LiveKitExecutor } from "./src/executor.js";
export type {
  LiveKitExecutorConfig,
  ConnectConfig,
  LiveKitToolDefinition,
} from "./src/types.js";
