/**
 * LiveKit Executor
 *
 * This module creates the LiveKitExecutor for voice/realtime support.
 * Separated from charter.ts to avoid module initialization issues in
 * serverless environments like Convex.
 */

import { LiveKitExecutor } from "@markov-machines/livekit-executor";

const liveKitExecutor = new LiveKitExecutor({
  debug: false,
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: "claude-sonnet-4-5",
  maxTokens: 4096,
});

export function getLiveKitExecutor(): LiveKitExecutor {
  return liveKitExecutor;
}

export { liveKitExecutor };
