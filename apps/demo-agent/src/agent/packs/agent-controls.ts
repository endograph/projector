import { z } from "zod";
import { commandResult, createPack } from "markov-machines";

export const agentControlsStateValidator = z.object({
  voiceEnabled: z.boolean().default(false),
  cameraEnabled: z.boolean().default(false),
  enableStreaming: z.boolean().default(false),
});

export type AgentControlsState = z.infer<typeof agentControlsStateValidator>;

export const agentControlsPack = createPack({
  name: "agentControls",
  description: "Agent controls: voice, camera, streaming preferences",
  validator: agentControlsStateValidator,
  instructions: (state: AgentControlsState) => {
    const parsed = agentControlsStateValidator.safeParse(state ?? {});
    const safeState: AgentControlsState = parsed.success
      ? parsed.data
      : { voiceEnabled: false, cameraEnabled: false, enableStreaming: false };

    const parts: string[] = [];

    if (safeState.voiceEnabled) {
      parts.push(
        [
          "Voice mode is enabled.",
          "Be concise and conversational.",
          "Avoid markdown and long lists; prefer short sentences suitable for speech.",
        ].join(" "),
      );
    }

    if (safeState.cameraEnabled) {
      parts.push(
        [
          "Camera mode is enabled.",
          'You may receive camera snapshots as user messages prefixed with "[Camera frame]" and an image block.',
          "These are snapshots (not continuous video). Only reference what you can actually see in the most recent frame when relevant or asked.",
        ].join(" "),
      );
    }

    return parts.join("\n\n");
  },
  tools: {
    setVoiceEnabled: {
      name: "setVoiceEnabled",
      description: "Enable or disable voice mode",
      inputSchema: z.object({ enabled: z.boolean() }),
      execute: (input, ctx) => {
        ctx.updateState({ voiceEnabled: input.enabled });
        return `voiceEnabled set to ${input.enabled}`;
      },
    },
    setCameraEnabled: {
      name: "setCameraEnabled",
      description: "Enable or disable camera mode",
      inputSchema: z.object({ enabled: z.boolean() }),
      execute: (input, ctx) => {
        ctx.updateState({ cameraEnabled: input.enabled });
        return `cameraEnabled set to ${input.enabled}`;
      },
    },
    setStreamingEnabled: {
      name: "setStreamingEnabled",
      description: "Enable or disable streaming mode",
      inputSchema: z.object({ enabled: z.boolean() }),
      execute: (input, ctx) => {
        ctx.updateState({ enableStreaming: input.enabled });
        return `enableStreaming set to ${input.enabled}`;
      },
    },
  },
  commands: {
    setVoiceEnabled: {
      name: "setVoiceEnabled",
      description: "Enable or disable voice mode",
      inputSchema: z.object({ enabled: z.boolean() }),
      execute: (input, ctx) => {
        ctx.updateState({ voiceEnabled: input.enabled });
        return commandResult({ ...ctx.state, voiceEnabled: input.enabled });
      },
    },
    setCameraEnabled: {
      name: "setCameraEnabled",
      description: "Enable or disable camera mode",
      inputSchema: z.object({ enabled: z.boolean() }),
      execute: (input, ctx) => {
        ctx.updateState({ cameraEnabled: input.enabled });
        return commandResult({ ...ctx.state, cameraEnabled: input.enabled });
      },
    },
    setStreamingEnabled: {
      name: "setStreamingEnabled",
      description: "Enable or disable streaming mode",
      inputSchema: z.object({ enabled: z.boolean() }),
      execute: (input, ctx) => {
        ctx.updateState({ enableStreaming: input.enabled });
        return commandResult({ ...ctx.state, enableStreaming: input.enabled });
      },
    },
  },
  initialState: { voiceEnabled: false, cameraEnabled: false, enableStreaming: false },
});
