import {
  createCharter,
  createStandardExecutor,
} from "markov-machines";
import { memoryPack } from "./packs/memory";
import { themePack } from "./packs/theme";
import { nameGateNode } from "./nodes/root";
import { fooNode } from "./nodes/foo";
import { demoMemoryNode } from "./nodes/demo-memory";
import { demoPingNode } from "./nodes/demo-ping";
import { demoFavoritesNode } from "./nodes/demo-favorites";

export const demoCharter = createCharter({
  name: "demo-assistant",
  instructions: "Be concise. No qualifiers or flowery language. State things simply. Always respond to the user after becoming active via a transition.",
  executor: createStandardExecutor({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: "claude-sonnet-4-5",
    maxTokens: 4096,
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
