import { createMachineContract } from "markov-machines";

export const demoContract = createMachineContract({
  commands: [
    ["agentControls", "setVoiceEnabled"],
    ["agentControls", "setCameraEnabled"],
    ["agentControls", "setStreamingEnabled"],
    ["demoPingNode", "ping"],
  ],
});
