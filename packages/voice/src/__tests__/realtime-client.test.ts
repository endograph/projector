import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TurnResult, PendingFunctionCall } from "../realtime-client.js";
import type { VoiceEvent, RealtimeToolDefinition } from "../types.js";

// Note: Full integration tests with LiveKit would require a real LiveKit server.
// These tests focus on type safety and interface contracts.

describe("TurnResult type", () => {
  it("should have the expected shape", () => {
    const turnResult: TurnResult = {
      userTranscript: "Hello",
      assistantTranscript: "Hi there!",
      functionCalls: [
        { callId: "call-1", name: "testTool", arguments: "{}" },
      ],
      wasInterrupted: false,
    };

    expect(turnResult.userTranscript).toBe("Hello");
    expect(turnResult.assistantTranscript).toBe("Hi there!");
    expect(turnResult.functionCalls).toHaveLength(1);
    expect(turnResult.wasInterrupted).toBe(false);
  });

  it("should support empty turn", () => {
    const emptyTurn: TurnResult = {
      userTranscript: "",
      assistantTranscript: "",
      functionCalls: [],
      wasInterrupted: false,
    };

    expect(emptyTurn.functionCalls).toHaveLength(0);
  });

  it("should support interrupted turn", () => {
    const interruptedTurn: TurnResult = {
      userTranscript: "I want to—",
      assistantTranscript: "",
      functionCalls: [],
      wasInterrupted: true,
    };

    expect(interruptedTurn.wasInterrupted).toBe(true);
  });
});

describe("PendingFunctionCall type", () => {
  it("should have the expected shape", () => {
    const functionCall: PendingFunctionCall = {
      callId: "call-123",
      name: "addTodo",
      arguments: '{"text":"Buy milk"}',
    };

    expect(functionCall.callId).toBe("call-123");
    expect(functionCall.name).toBe("addTodo");
    expect(JSON.parse(functionCall.arguments)).toEqual({ text: "Buy milk" });
  });
});

describe("RealtimeToolDefinition type", () => {
  it("should define a function tool with parameters", () => {
    const tool: RealtimeToolDefinition = {
      type: "function",
      name: "addTodo",
      description: "Add a new todo item",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The todo text" },
          priority: { type: "number", description: "Priority 1-5" },
        },
        required: ["text"],
      },
    };

    expect(tool.type).toBe("function");
    expect(tool.name).toBe("addTodo");
    expect(tool.description).toContain("todo");
    expect(tool.parameters).toBeDefined();
  });

  it("should define a tool without parameters", () => {
    const tool: RealtimeToolDefinition = {
      type: "function",
      name: "clearAll",
      description: "Clear all items",
      parameters: {},
    };

    expect(tool.name).toBe("clearAll");
  });
});

describe("VoiceEvent types", () => {
  it("should support all event types", () => {
    const events: VoiceEvent[] = [
      { type: "session_started", sessionId: "sess-1" },
      { type: "speech_started" },
      { type: "speech_ended", transcript: "Hello" },
      { type: "response_started" },
      { type: "response_text", text: "Hi", delta: "Hi" },
      { type: "response_audio", audio: new Uint8Array([0, 1, 2]) },
      { type: "response_ended", transcript: "Hi there" },
      { type: "tool_call_started", callId: "c1", name: "test" },
      { type: "tool_call_completed", callId: "c1", name: "test", result: "ok" },
      { type: "transition", fromNode: "a", toNode: "b" },
      { type: "state_updated", instanceId: "i1", state: {} },
      { type: "interrupted" },
      { type: "error", error: new Error("test") },
    ];

    // All events should have a type
    expect(events.every(e => e.type)).toBe(true);
    expect(events).toHaveLength(13);
  });

  it("should discriminate by type", () => {
    const event: VoiceEvent = { type: "speech_ended", transcript: "Hello" };

    if (event.type === "speech_ended") {
      expect(event.transcript).toBe("Hello");
    }
  });
});
