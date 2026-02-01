/**
 * Demo Agent Charter
 *
 * Exports a factory function for creating the charter. The caller provides the executor,
 * which allows this module to be imported in environments without process.env (e.g. Convex).
 *
 * For LiveKit voice support, see livekit.ts which overrides the executor.
 */

import { createCharter, type Executor } from "markov-machines";

import { memoryPack } from "./packs/memory.js";
import { themePack } from "./packs/theme.js";
import { nameGateNode } from "./nodes/root.js";
import { fooNode } from "./nodes/foo.js";
import { demoMemoryNode } from "./nodes/demo-memory.js";
import { demoPingNode } from "./nodes/demo-ping.js";
import { demoFavoritesNode } from "./nodes/demo-favorites.js";

export function createDemoCharter(executor: Executor<any>) {
  return createCharter({
    name: "demo-assistant",
    instructions: "Be concise. No qualifiers or flowery language. State things simply. Always respond to the user after becoming active via a transition.",
    executor,
    packs: [memoryPack, themePack],
    nodes: {
      nameGateNode,
      fooNode,
      demoMemoryNode,
      demoPingNode,
      demoFavoritesNode,
    },
  });
}

export { nameGateNode, fooNode, demoMemoryNode, demoPingNode, demoFavoritesNode };
export { nameGateNode as rootNode };
