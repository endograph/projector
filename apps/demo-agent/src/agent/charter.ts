/**
 * Demo Agent Charter
 *
 * Base charter using StandardExecutor for serverless environments (Convex).
 * For LiveKit voice support, see livekit.ts which creates a LiveKit-enabled
 * version of this charter.
 */

import { createCharter, createStandardExecutor } from "markov-machines";

import { memoryPack } from "./packs/memory.js";
import { themePack } from "./packs/theme.js";
import { nameGateNode } from "./nodes/root.js";
import { fooNode } from "./nodes/foo.js";
import { demoMemoryNode } from "./nodes/demo-memory.js";
import { demoPingNode } from "./nodes/demo-ping.js";
import { demoFavoritesNode } from "./nodes/demo-favorites.js";

export const demoCharterStandard = createCharter({
  name: "demo-assistant",
  instructions: "Be concise. No qualifiers or flowery language. State things simply. Always respond to the user after becoming active via a transition.",
  executor: createStandardExecutor({
    model: "claude-sonnet-4-5",
    apiKey: process.env.ANTHROPIC_API_KEY,
  }),
  packs: [memoryPack, themePack],
  nodes: {
    nameGateNode,
    fooNode,
    demoMemoryNode,
    demoPingNode,
    demoFavoritesNode,
  },
});

export { nameGateNode, fooNode, demoMemoryNode, demoPingNode, demoFavoritesNode };
export { nameGateNode as rootNode };
