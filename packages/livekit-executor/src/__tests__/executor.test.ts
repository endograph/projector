import { describe, expect, it, vi } from "vitest";
import { createGetStateAction, createTool, type CompiledInference } from "@projectors/core";
import { z } from "zod";
import {
  LiveKitExecutor,
  SYNTHETIC_ROOT_GENERATOR_ID,
  buildLiveKitInstructions,
  buildLiveKitToolDefinitions,
} from "../executor.ts";
import type {
  ExecutorRunResult,
  ExecutorRunRequest,
  Frame,
  FrameDraft,
  LiveKitAgentLike,
  LiveKitSessionLike,
  LiveKitTextOutputLike,
  ProjectorExecutor,
  RuntimeSyncContext,
} from "../types.ts";

class FakeTextOutput implements LiveKitTextOutputLike {
  captured: string[] = [];
  flushes = 0;
  attached = 0;
  detached = 0;

  captureText(text: string): void {
    this.captured.push(text);
  }

  flush(): void {
    this.flushes += 1;
  }

  onAttached(): void {
    this.attached += 1;
  }

  onDetached(): void {
    this.detached += 1;
  }
}

class FakeSession implements LiveKitSessionLike {
  handlers = new Map<string, Set<(event: unknown) => void>>();
  replies: unknown[] = [];
  output?: { transcription?: LiveKitTextOutputLike | null };

  constructor(transcription?: LiveKitTextOutputLike | null) {
    if (transcription !== undefined) {
      this.output = { transcription };
    }
  }

  on(event: string, handler: (event: unknown) => void): void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }

  off(event: string, handler: (event: unknown) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload);
    }
  }

  generateReply(options?: { userInput?: string; instructions?: string }): void {
    this.replies.push(options);
  }
}

class FakeRoom {
  [key: string]: unknown;

  handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, handler: (...args: unknown[]) => void): void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

describe("LiveKitExecutor", () => {
  it("delegates non-root activations to the discrete executor", async () => {
    const discrete = fakeDiscreteExecutor();
    const executor = new LiveKitExecutor({
      session: new FakeSession(),
      discreteExecutor: discrete,
    });

    const result = await executor.run(request({ generatorId: "worker:search" }));

    expect(result).toEqual({ completionReason: "done", value: "discrete" });
    expect(discrete.run).toHaveBeenCalledOnce();
  });

  it("delegates root activations when realtime is inactive", async () => {
    const discrete = fakeDiscreteExecutor();
    const executor = new LiveKitExecutor({
      session: new FakeSession(),
      discreteExecutor: discrete,
    });

    const result = await executor.run(request());

    expect(result).toEqual({ completionReason: "done", value: "discrete" });
    expect(discrete.run).toHaveBeenCalledOnce();
  });

  it("syncs compiled inference and returns delegated for active realtime root activations", async () => {
    const discrete = fakeDiscreteExecutor();
    const session = new FakeSession();
    const realtimeSession = {
      updateInstructions: vi.fn(),
      updateTools: vi.fn(),
    };
    const agent: LiveKitAgentLike = {
      _agentActivity: { realtimeLLMSession: realtimeSession },
    };
    const frames: FrameDraft[] = [];
    const compiled = inference({
      systemParts: ["You are concise."],
      dynamicParts: ["Current mode: voice."],
      history: [{ type: "user", text: "hello" }],
    });
    const executor = new LiveKitExecutor({
      session,
      discreteExecutor: discrete,
      agent,
    });
    await executor.syncRuntime(syncContext({
      inference: compiled,
      visibleFrames: [{ id: "user-1", messages: [{ type: "user", text: "hello" }] }],
    }, frames));

    const result = await executor.run(request({ inference: compiled }));

    expect(result).toEqual({ completionReason: "delegated" });
    expect(discrete.run).not.toHaveBeenCalled();
    expect(session.replies).toEqual([{ userInput: "hello" }]);
    expect(realtimeSession.updateInstructions).toHaveBeenCalledWith(
      expect.stringContaining("You are concise."),
    );
    expect(agent._instructions).toContain("Current mode: voice.");
  });

  it("does not forward the same visible user frame to realtime twice", async () => {
    const session = new FakeSession();
    const executor = new LiveKitExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      realtime: { enabled: true },
    });
    const visibleFrames = [{ id: "user-1", messages: [{ type: "user", text: "hello" }] }] as Frame[];

    await executor.syncRuntime(syncContext({ visibleFrames }));
    await executor.syncRuntime(syncContext({ visibleFrames }));

    expect(session.replies).toEqual([{ userInput: "hello" }]);
  });

  it("records LiveKit transcript events as inert synthetic root frames", async () => {
    const session = new FakeSession();
    const frames: FrameDraft[] = [];
    const executor = new LiveKitExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      realtime: { enabled: true },
    });
    await executor.syncRuntime(syncContext({}, frames));

    session.emit("user_input_transcribed", {
      transcript: "what is the plan?",
      isFinal: true,
      speakerId: "speaker-1",
    });
    session.emit("conversation_item_added", {
      item: {
        id: "item-1",
        role: "assistant",
        textContent: "Here is the plan.",
      },
      createdAt: 123,
    });

    await Promise.resolve();

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      generatorId: SYNTHETIC_ROOT_GENERATOR_ID,
      inert: true,
      messages: [
        {
          type: "user",
          text: "what is the plan?",
          audience: "broadcast",
          source: { external: true },
          speakerId: "speaker-1",
        },
      ],
    });
    expect(frames[1]).toMatchObject({
      generatorId: SYNTHETIC_ROOT_GENERATOR_ID,
      inert: true,
      messages: [
        {
          type: "assistant",
          text: "Here is the plan.",
          audience: "self",
          source: { external: true },
          messageId: "item-1",
          createdAt: 123,
        },
      ],
    });
  });

  it("emits a user transcript envelope on speech start and reuses its id for the final transcript", async () => {
    const frames: FrameDraft[] = [];
    const userUpdates: any[] = [];
    const session = new FakeSession();
    const executor = new LiveKitExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      realtime: { enabled: true },
      onUserTranscriptUpdate: (update) => {
        userUpdates.push(update);
      },
    });
    await executor.syncRuntime(syncContext({}, frames));

    session.emit("user_state_changed", {
      oldState: "listening",
      newState: "speaking",
    });
    session.emit("user_input_transcribed", {
      transcript: "what is the plan?",
      isFinal: true,
    });
    await flushPromises();

    expect(frames).toHaveLength(1);
    const message = frames[0]!.messages[0] as any;
    const messageId = message.messageId;
    expect(typeof messageId).toBe("string");
    expect(userUpdates).toEqual([
      {
        messageId,
        text: "",
        streamState: "streaming",
        streamSeq: 0,
      },
      {
        messageId,
        text: "what is the plan?",
        streamState: "complete",
        streamSeq: 1,
      },
    ]);
    expect(message).toMatchObject({
      type: "user",
      text: "what is the plan?",
      messageId,
      streamState: "complete",
      streamSeq: 1,
    });
  });

  it("enqueues parsed LiveKit data messages as active user frames", async () => {
    const session = new FakeSession();
    const room = new FakeRoom();
    const frames: FrameDraft[] = [];
    const executor = new LiveKitExecutor({
      session,
      room,
      discreteExecutor: fakeDiscreteExecutor(),
      input: {
        messageTopic: "demo.message.v1",
        parseDataMessage: (payload) =>
          JSON.parse(new TextDecoder().decode(payload)).content,
      },
    });
    await executor.syncRuntime(syncContext({}, frames));

    room.emit(
      "data_received",
      new TextEncoder().encode(JSON.stringify({ content: "hello" })),
      undefined,
      undefined,
      "demo.message.v1",
    );
    await flushPromises();

    expect(frames).toHaveLength(1);
    expect(frames[0]?.inert).toBeUndefined();
    expect(frames[0]).toMatchObject({
      metadata: { mode: "text", transport: "livekit" },
      messages: [
        {
          type: "user",
          text: "hello",
          audience: "broadcast",
          source: { external: true, transport: "livekit" },
        },
      ],
    });
  });

  it("emits assistant transcription output out-of-band and only enqueues the complete assistant frame", async () => {
    const originalOutput = new FakeTextOutput();
    const session = new FakeSession(originalOutput);
    const frames: FrameDraft[] = [];
    const streamUpdates: any[] = [];
    const executor = new LiveKitExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      realtime: { enabled: true },
      onAssistantTranscriptUpdate: (update) => {
        streamUpdates.push(update);
      },
    });

    await executor.syncRuntime(syncContext({}, frames));

    await session.output?.transcription?.captureText("Hel");
    await session.output?.transcription?.captureText("lo");
    session.output?.transcription?.flush();
    await flushPromises();

    expect(frames).toHaveLength(1);
    const messages = frames.map((frame) => frame.messages[0] as any);
    const messageId = messages[0]!.messageId;
    expect(typeof messageId).toBe("string");
    expect(streamUpdates.map((update) => update.messageId)).toEqual([
      messageId,
      messageId,
      messageId,
    ]);
    expect(streamUpdates.map((update) => update.text)).toEqual(["", "Hel", "Hello"]);
    expect(streamUpdates.map((update) => update.delta)).toEqual([undefined, "Hel", "lo"]);
    expect(streamUpdates.map((update) => update.streamState)).toEqual([
      "streaming",
      "streaming",
      "streaming",
    ]);
    expect(streamUpdates.map((update) => update.streamSeq)).toEqual([0, 1, 2]);
    expect(messages[0]).toMatchObject({
      messageId,
      text: "Hello",
      streamState: "complete",
      streamSeq: 3,
      source: { external: true },
    });
  });

  it("forwards transcript output to the original LiveKit sink", async () => {
    const originalOutput = new FakeTextOutput();
    const session = new FakeSession(originalOutput);
    const executor = new LiveKitExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      realtime: { enabled: true },
    });

    await executor.syncRuntime(syncContext({}, []));

    session.output?.transcription?.onAttached?.();
    await session.output?.transcription?.captureText("Hi");
    session.output?.transcription?.flush();
    session.output?.transcription?.onDetached?.();

    expect(originalOutput.captured).toEqual(["Hi"]);
    expect(originalOutput.flushes).toBe(1);
    expect(originalOutput.attached).toBe(1);
    expect(originalOutput.detached).toBe(1);
  });

  it("restores original transcription output on disconnect", async () => {
    const originalOutput = new FakeTextOutput();
    const session = new FakeSession(originalOutput);
    const executor = new LiveKitExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      realtime: { enabled: true },
    });

    await executor.syncRuntime(syncContext({}, []));

    expect(session.output?.transcription).not.toBe(originalOutput);

    executor.disconnect();

    expect(session.output?.transcription).toBe(originalOutput);
  });

  it("does not duplicate conversation_item_added when assistant stream wrapper is active", async () => {
    const session = new FakeSession(new FakeTextOutput());
    const frames: FrameDraft[] = [];
    const executor = new LiveKitExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      realtime: { enabled: true },
    });

    await executor.syncRuntime(syncContext({}, frames));

    await session.output?.transcription?.captureText("Here is the plan.");
    session.output?.transcription?.flush();
    await flushPromises();
    session.emit("conversation_item_added", {
      item: {
        id: "item-1",
        role: "assistant",
        textContent: "Here is the plan.",
      },
    });
    await Promise.resolve();

    expect(frames).toHaveLength(1);
    expect(frames.map((frame) => frame.messages[0]?.streamState)).toEqual([
      "complete",
    ]);
  });

  it("does not emit partial transcript frames when no stream callback is configured", async () => {
    const session = new FakeSession(new FakeTextOutput());
    const frames: FrameDraft[] = [];
    const executor = new LiveKitExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      realtime: { enabled: true },
    });
    await executor.syncRuntime(syncContext({}, frames));

    await session.output?.transcription?.captureText("Hel");
    await session.output?.transcription?.captureText("lo");

    expect(frames).toHaveLength(0);

    session.output?.transcription?.flush();
    await flushPromises();

    expect(frames).toHaveLength(1);
    expect(frames[0]?.messages[0]).toMatchObject({
      type: "assistant",
      text: "Hello",
      streamState: "complete",
    });
  });

  it("uses last compiled tool wins and resolves callbacks against the latest snapshot", async () => {
    const first = createTool({
      state: null,
      name: "lookup",
      description: "first",
      inputSchema: z.object({ query: z.string() }),
      run: vi.fn(() => "first-result"),
    });
    const secondRun = vi.fn(() => "second-result");
    const second = createTool({
      state: null,
      name: "lookup",
      description: "second",
      inputSchema: z.object({ query: z.string() }),
      run: secondRun,
    });
    const frames: FrameDraft[] = [];
    const realtimeSession = {
      updateInstructions: vi.fn(),
      updateTools: vi.fn(),
    };
    const session = new FakeSession();
    const executor = new LiveKitExecutor({
      session,
      agent: { _agentActivity: { realtimeLLMSession: realtimeSession } },
      discreteExecutor: fakeDiscreteExecutor(),
    });

    await executor.syncRuntime(
      syncContext({
        inference: inference({
          tools: [
            first,
            second,
            createGetStateAction(),
          ] as CompiledInference["tools"],
          retrievableStates: [
            {
              address: "member:root/profile",
              target: { instanceId: "root", stateKey: "profile" },
            },
          ],
        }),
      }, frames),
    );

    expect(executor.getTool("lookup")).toBe(second);
    const toolContext = realtimeSession.updateTools.mock.calls.at(-1)?.[0];
    expect(toolContext.lookup.description).toBe("second");
    expect(toolContext.getState.description).toContain("Retrieve");

    await expect(toolContext.lookup.execute({ query: "x" })).resolves.toBe("second-result");
    expect(secondRun).toHaveBeenCalledWith({ query: "x" }, {});
    expect(frames.map((frame) => frame.messages[0]?.value)).toEqual([
      { phase: "call", input: { query: "x" } },
      { phase: "result", value: "second-result" },
    ]);
  });

  it("executes projected getState through the current sync context", async () => {
    const getStateAction = createGetStateAction();
    const getState = vi.fn((address: string) => {
      if (address !== "profile") {
        throw new Error(`Unknown retrievable state address "${address}"`);
      }
      return `state:${address}`;
    });
    const createActionContext = vi.fn(() => ({ getState }));
    const realtimeSession = {
      updateInstructions: vi.fn(),
      updateTools: vi.fn(),
    };
    const executor = new LiveKitExecutor({
      session: new FakeSession(),
      agent: { _agentActivity: { realtimeLLMSession: realtimeSession } },
      discreteExecutor: fakeDiscreteExecutor(),
    });

    await executor.syncRuntime(
      syncContext({
        createActionContext,
        inference: inference({
          tools: [getStateAction],
          retrievableStates: [
            {
              address: "profile",
              target: { instanceId: "root", stateKey: "profile" },
            },
          ],
        }),
      }),
    );

    const toolContext = realtimeSession.updateTools.mock.calls.at(-1)?.[0];
    await expect(toolContext.getState.execute({ address: "profile" })).resolves.toBe(
      "state:profile",
    );
    await expect(toolContext.getState.execute({ address: "secret" })).rejects.toThrow(
      /Unknown retrievable state address/,
    );
    expect(createActionContext).toHaveBeenCalledWith(getStateAction);
    expect(getState).toHaveBeenCalledWith("profile");
  });

  it("syncs projected retrieval tools without a current request", async () => {
    const executor = new LiveKitExecutor({
      session: new FakeSession(),
      discreteExecutor: fakeDiscreteExecutor(),
    });

    await executor.syncRuntime(
      syncContext({
        inference: inference({
          tools: [createGetStateAction()],
          retrievableStates: [
            {
              address: "profile",
              target: { instanceId: "root", stateKey: "profile" },
            },
          ],
        }),
      }),
    );

    await expect(executor.executeTool("getState", { address: "profile" })).rejects.toThrow(
      /No getState handler/,
    );
  });

  it("removes event handlers on disconnect", () => {
    const session = new FakeSession();
    const executor = new LiveKitExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
    });

    expect(session.handlers.get("user_state_changed")?.size).toBe(1);
    expect(session.handlers.get("user_input_transcribed")?.size).toBe(1);
    expect(session.handlers.get("conversation_item_added")?.size).toBe(1);

    executor.disconnect();

    expect(session.handlers.get("user_state_changed")?.size).toBe(0);
    expect(session.handlers.get("user_input_transcribed")?.size).toBe(0);
    expect(session.handlers.get("conversation_item_added")?.size).toBe(0);
  });
});

describe("LiveKit prompt and tool rendering", () => {
  it("renders compiled inference without discovering runtime state", () => {
    const rendered = buildLiveKitInstructions(
      inference({
        systemParts: ["System A"],
        dynamicParts: ["Dynamic B"],
        history: [
          { type: "user", text: "Hi" },
          { type: "assistant", text: "Hello" },
          { type: "tool", name: "lookup", value: { ok: true } },
        ],
      }),
    );

    expect(rendered).toContain("## System\n\nSystem A");
    expect(rendered).toContain("## Dynamic Context\n\nDynamic B");
    expect(rendered).toContain("User: Hi");
    expect(rendered).toContain('Tool lookup: {"ok":true}');
  });

  it("exports last-wins LiveKit tool definitions", () => {
    const definitions = buildLiveKitToolDefinitions(
      inference({
        tools: [
          createTool({ state: null, name: "same", description: "first" }),
          createTool({ state: null, name: "same", description: "last" }),
          createGetStateAction(),
        ],
        retrievableStates: [
          {
            address: "state",
            target: { instanceId: "root", stateKey: "state" },
          },
        ],
      }),
    );

    expect(definitions.map((definition) => definition.name)).toEqual(["same", "getState"]);
    expect(definitions[0]?.description).toBe("last");
  });
});

function fakeDiscreteExecutor(): ProjectorExecutor & { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn((_request: ExecutorRunRequest): ExecutorRunResult => ({
      completionReason: "done",
      value: "discrete",
    })),
  };
}

function request(overrides: Partial<ExecutorRunRequest> = {}): ExecutorRunRequest {
  return {
    generatorId: SYNTHETIC_ROOT_GENERATOR_ID,
    activationId: "activation-1",
    runtimeInstanceId: "synthetic-root",
    inference: inference(),
    enqueueFrame: enqueueTo([]),
    ...overrides,
  };
}

function inference(overrides: Partial<CompiledInference> = {}): CompiledInference {
  return {
    systemParts: [],
    history: [],
    dynamicParts: [],
    tools: [],
    retrievableStates: [],
    ...overrides,
  };
}

function syncContext(
  overrides: Partial<RuntimeSyncContext> = {},
  frames: FrameDraft[] = [],
): RuntimeSyncContext {
  const machine = overrides.machine ?? fakeMachine(frames);
  return {
    machine,
    runtimeInstanceId: "synthetic-root",
    generator: {
      id: SYNTHETIC_ROOT_GENERATOR_ID,
      kind: "primary",
      runtimeInstanceId: "synthetic-root",
    },
    inference: inference(),
    visibleFrames: [],
    createActionContext: () => ({}),
    enqueueFrame: (frame) => machine.enqueueFrame(frame),
    ...overrides,
  };
}

function fakeMachine(frames: FrameDraft[]): RuntimeSyncContext["machine"] {
  const storedFrames: Frame[] = [];
  return {
    id: "machine",
    root: { type: "synthetic-root", instances: [] },
    charter: {} as RuntimeSyncContext["machine"]["charter"],
    frames: storedFrames,
    enqueueFrame(frame) {
      const enqueued = "id" in frame && typeof frame.id === "string"
        ? { ...frame } as Frame
        : { id: `frame-${frames.length + 1}`, ...frame };
      frames.push(enqueued);
      storedFrames.push(enqueued);
      return enqueued;
    },
    ingestInertFrame(frame) {
      storedFrames.push(frame);
    },
    subscribe() {
      return () => undefined;
    },
  };
}

function enqueueTo(frames: FrameDraft[]) {
  return async (frame: FrameDraft): Promise<Frame> => {
    frames.push(frame);
    return { id: `frame-${frames.length}`, ...frame };
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
