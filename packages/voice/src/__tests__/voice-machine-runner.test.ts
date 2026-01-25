import { describe, it, expect, vi } from "vitest";
import { createVoiceMachineRunner } from "../voice-machine-runner.js";
import type { VoiceRuntimeConfig, VoiceMachineRunner } from "../types.js";

// Note: Full integration tests would require mocking LiveKit agents.
// These tests focus on the factory function and interface.

describe("createVoiceMachineRunner", () => {
  const config: VoiceRuntimeConfig = {
    openaiApiKey: "test-api-key",
    debug: false,
  };

  it("should create a voice machine runner", () => {
    const runner = createVoiceMachineRunner(config);

    expect(runner).toBeDefined();
  });

  it("should have all required methods", () => {
    const runner = createVoiceMachineRunner(config);

    expect(typeof runner.run).toBe("function");
    expect(typeof runner.stop).toBe("function");
    expect(typeof runner.on).toBe("function");
    expect(typeof runner.getTranscriptHistory).toBe("function");
  });

  it("should have isConnected property", () => {
    const runner = createVoiceMachineRunner(config);

    expect(typeof runner.isConnected).toBe("boolean");
    expect(runner.isConnected).toBe(false);
  });

  it("should return empty transcript history initially", () => {
    const runner = createVoiceMachineRunner(config);

    const history = runner.getTranscriptHistory();
    expect(history).toEqual([]);
  });

  describe("event subscription", () => {
    it("should subscribe to events and return unsubscribe function", () => {
      const runner = createVoiceMachineRunner(config);
      const handler = vi.fn();

      const unsubscribe = runner.on("session_started", handler);

      expect(typeof unsubscribe).toBe("function");
    });

    it("should allow unsubscribing", () => {
      const runner = createVoiceMachineRunner(config);
      const handler = vi.fn();

      const unsubscribe = runner.on("session_started", handler);
      unsubscribe();

      // Should not throw
      expect(true).toBe(true);
    });

    it("should support multiple event types", () => {
      const runner = createVoiceMachineRunner(config);

      const handlers = {
        sessionStarted: vi.fn(),
        speechEnded: vi.fn(),
        error: vi.fn(),
      };

      runner.on("session_started", handlers.sessionStarted);
      runner.on("speech_ended", handlers.speechEnded);
      runner.on("error", handlers.error);

      // Should not throw when subscribing to multiple event types
      expect(true).toBe(true);
    });
  });

  describe("configuration", () => {
    it("should accept minimal config", () => {
      const minimalConfig: VoiceRuntimeConfig = {
        openaiApiKey: "key",
      };

      const runner = createVoiceMachineRunner(minimalConfig);
      expect(runner).toBeDefined();
    });

    it("should accept full config", () => {
      const fullConfig: VoiceRuntimeConfig = {
        openaiApiKey: "key",
        model: "gpt-4o-realtime-preview",
        voice: "alloy",
        turnDetection: {
          type: "server_vad",
          threshold: 0.5,
          silenceDurationMs: 500,
        },
        debug: true,
      };

      const runner = createVoiceMachineRunner(fullConfig);
      expect(runner).toBeDefined();
    });
  });
});

describe("VoiceMachineRunner interface contract", () => {
  it("should match the expected interface", () => {
    const config: VoiceRuntimeConfig = { openaiApiKey: "test-key" };
    const runner = createVoiceMachineRunner(config);

    // Type-check: runner should satisfy VoiceMachineRunner interface
    const _: VoiceMachineRunner = runner;
    expect(_).toBeDefined();
  });
});
