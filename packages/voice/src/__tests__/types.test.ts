import { describe, it, expect } from "vitest";
import type {
  VoiceRuntimeConfig,
  VoiceId,
  TurnDetectionConfig,
  LiveKitOptions,
  VoiceRunOptions,
  VoiceMachineRunner,
  VoiceEvent,
  VoiceTurnResult,
  RealtimeToolDefinition,
  RealtimeSessionConfig,
} from "../types.js";

describe("Voice Types", () => {
  describe("VoiceRuntimeConfig", () => {
    it("should accept minimal config", () => {
      const config: VoiceRuntimeConfig = {
        openaiApiKey: "test-key",
      };
      expect(config.openaiApiKey).toBe("test-key");
    });

    it("should accept full config", () => {
      const config: VoiceRuntimeConfig = {
        openaiApiKey: "test-key",
        model: "gpt-4o-realtime-preview-2024-12-17",
        voice: "alloy",
        turnDetection: {
          type: "server_vad",
          threshold: 0.5,
          silenceDurationMs: 500,
        },
        debug: true,
      };
      expect(config.voice).toBe("alloy");
      expect(config.debug).toBe(true);
    });
  });

  describe("VoiceId", () => {
    it("should accept valid voice IDs", () => {
      const voices: VoiceId[] = [
        "alloy",
        "ash",
        "ballad",
        "coral",
        "echo",
        "sage",
        "shimmer",
        "verse",
      ];
      expect(voices).toHaveLength(8);
    });
  });

  describe("TurnDetectionConfig", () => {
    it("should have server_vad type", () => {
      const config: TurnDetectionConfig = {
        type: "server_vad",
        threshold: 0.5,
        prefixPaddingMs: 300,
        silenceDurationMs: 500,
      };
      expect(config.type).toBe("server_vad");
    });
  });

  describe("LiveKitOptions", () => {
    it("should require all fields", () => {
      const options: LiveKitOptions = {
        serverUrl: "wss://example.livekit.cloud",
        roomName: "test-room",
        token: "jwt-token",
      };
      expect(options.serverUrl).toContain("wss://");
    });
  });

  describe("VoiceEvent", () => {
    it("should support session_started event", () => {
      const event: VoiceEvent = {
        type: "session_started",
        sessionId: "session-123",
      };
      expect(event.type).toBe("session_started");
    });

    it("should support speech events", () => {
      const started: VoiceEvent = { type: "speech_started" };
      const ended: VoiceEvent = {
        type: "speech_ended",
        transcript: "Hello world",
      };
      expect(started.type).toBe("speech_started");
      expect(ended.type).toBe("speech_ended");
    });

    it("should support response events", () => {
      const started: VoiceEvent = { type: "response_started" };
      const text: VoiceEvent = {
        type: "response_text",
        text: "Hello",
        delta: "Hello",
      };
      const audio: VoiceEvent = {
        type: "response_audio",
        audio: new Uint8Array([0, 1, 2]),
      };
      const ended: VoiceEvent = {
        type: "response_ended",
        transcript: "Hello, how can I help?",
      };
      expect(started.type).toBe("response_started");
      expect(text.type).toBe("response_text");
      expect(audio.type).toBe("response_audio");
      expect(ended.type).toBe("response_ended");
    });

    it("should support tool call events", () => {
      const started: VoiceEvent = {
        type: "tool_call_started",
        callId: "call-1",
        name: "addTodo",
      };
      const completed: VoiceEvent = {
        type: "tool_call_completed",
        callId: "call-1",
        name: "addTodo",
        result: "Todo added",
      };
      expect(started.type).toBe("tool_call_started");
      expect(completed.type).toBe("tool_call_completed");
    });

    it("should support transition event", () => {
      const event: VoiceEvent = {
        type: "transition",
        fromNode: "nodeA",
        toNode: "nodeB",
      };
      expect(event.type).toBe("transition");
    });

    it("should support state_updated event", () => {
      const event: VoiceEvent = {
        type: "state_updated",
        instanceId: "instance-1",
        state: { count: 5 },
      };
      expect(event.type).toBe("state_updated");
    });

    it("should support interrupted event", () => {
      const event: VoiceEvent = { type: "interrupted" };
      expect(event.type).toBe("interrupted");
    });

    it("should support error event", () => {
      const event: VoiceEvent = {
        type: "error",
        error: new Error("Test error"),
      };
      expect(event.type).toBe("error");
    });
  });

  describe("RealtimeToolDefinition", () => {
    it("should define a function tool", () => {
      const tool: RealtimeToolDefinition = {
        type: "function",
        name: "addTodo",
        description: "Add a new todo item",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
      };
      expect(tool.type).toBe("function");
      expect(tool.name).toBe("addTodo");
    });
  });

  describe("VoiceTurnResult", () => {
    it("should have all required fields", () => {
      const result: VoiceTurnResult = {
        instanceId: "instance-1",
        userTranscript: "Add milk to my list",
        messages: [{ role: "assistant", content: "I've added milk to your list." }],
        updatedInstance: {
          id: "instance-1",
          node: {} as any,
          state: {},
        },
        yieldReason: "end_turn",
        transitioned: false,
      };
      expect(result.instanceId).toBe("instance-1");
      expect(result.yieldReason).toBe("end_turn");
    });
  });
});
