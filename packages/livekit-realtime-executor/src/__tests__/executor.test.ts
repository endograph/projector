import { describe, expect, it, vi } from "vitest";
import { llm } from "@livekit/agents";
import {
  ROOT_RUNTIME_INSTANCE_ID,
  createGetStateAction,
  createNode,
  createAction,
  createUnboundActionContext,
  textAssistantMessage,
  textUserMessage,
  type CompiledInference,
  type ContentPart,
} from "@projectors/core";
import { z } from "zod";
import {
  LiveKitRealtimeExecutor,
  REALTIME_GENERATOR_ID,
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

describe("LiveKitRealtimeExecutor", () => {
  it("delegates non-root activations to the discrete executor", async () => {
    const discrete = fakeDiscreteExecutor();
    const executor = new LiveKitRealtimeExecutor({
      session: new FakeSession(),
      discreteExecutor: discrete,
    });

    const result = await executor.run(request({ generatorId: "worker:search" }));

    expect(result).toEqual({ completionReason: "done", value: "discrete" });
    expect(discrete.run).toHaveBeenCalledOnce();
  });

  it("delegates root activations when realtime is inactive", async () => {
    const discrete = fakeDiscreteExecutor();
    const executor = new LiveKitRealtimeExecutor({
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
    const realtimeSession = fakeRawRealtimeSession();
    const agent: LiveKitAgentLike = {
      _agentActivity: { realtimeLLMSession: realtimeSession },
    };
    const frames: FrameDraft[] = [];
    const compiled = inference({
      systemParts: ["You are concise."],
      dynamicParts: ["Current mode: voice."],
      history: [{ ...textUserMessage("hello") }],
    });
    const executor = new LiveKitRealtimeExecutor({
      session,
      discreteExecutor: discrete,
      agent,
    });
    await executor.syncRuntime(syncContext({
      inference: compiled,
      visibleFrames: [{ id: "user-1", messages: [{ ...textUserMessage("hello") }] }],
    }, frames));

    const result = await executor.run(request({ inference: compiled }));

    expect(result).toEqual({ completionReason: "delegated" });
    expect(discrete.run).not.toHaveBeenCalled();
    expect(session.replies).toEqual([undefined]);
    expect(realtimeSession.sendEvents.some((event) => event.type === "response.create")).toBe(false);
    expect(realtimeSession.updateInstructions).toHaveBeenCalledWith(
      expect.stringContaining("You are concise."),
    );
    expect(agent._instructions).toContain("Application-provided dynamic context");
  });

  it("does not update realtime session instructions while realtime is disabled", async () => {
    const realtimeSession = fakeRawRealtimeSession();
    const agent: LiveKitAgentLike = {
      _agentActivity: { realtimeLLMSession: realtimeSession },
    };
    const executor = new LiveKitRealtimeExecutor({
      session: new FakeSession(),
      discreteExecutor: fakeDiscreteExecutor(),
      agent,
      realtime: { enabled: false },
    });

    await executor.syncRuntime(syncContext({
      inference: inference({
        systemParts: ["You are concise."],
        dynamicParts: ["Camera data."],
      }),
    }));

    expect(realtimeSession.updateInstructions).not.toHaveBeenCalled();
    expect(realtimeSession.updateTools).not.toHaveBeenCalled();
    expect(agent._instructions).toContain("Camera data.");
  });

  it("rejects active realtime sessions without raw event support", async () => {
    const realtimeSession = {
      updateInstructions: vi.fn(),
      updateTools: vi.fn(),
    };
    const executor = new LiveKitRealtimeExecutor({
      session: new FakeSession(),
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: realtimeSession } },
    });

    await expect(executor.syncRuntime(syncContext())).rejects.toThrow(
      /requires a realtime session with sendEvent/,
    );
  });

  it("realizes active realtime root prompts as LiveKit instructions and tools", async () => {
    const discrete = fakeDiscreteExecutor();
    const executor = new LiveKitRealtimeExecutor({
      session: new FakeSession(),
      discreteExecutor: discrete,
      realtime: { enabled: true },
    });

    const prompt = await executor.realizePrompt(
      request({
        inference: inference({
          systemParts: ["System A"],
          dynamicParts: ["Dynamic B"],
          history: [{ ...textUserMessage("Hi") }],
          tools: [createAction({ state: null, name: "lookup", description: "Lookup things" })],
        }),
      }),
    );

    const input = prompt.input as { instructions: string; tools: Array<{ name: string }> };
    expect(prompt.provider).toBe("livekit");
    expect(input.instructions).toContain("## System\n\nSystem A");
    expect(input.instructions).toContain("## Dynamic Context\n\nDynamic B");
    expect(input.instructions).toContain("User: Hi");
    expect(input.tools.map((tool) => tool.name)).toEqual(["lookup"]);
    expect(discrete.realizePrompt).not.toHaveBeenCalled();
  });

  it("does not forward the same visible user frame to realtime twice", async () => {
    const session = new FakeSession();
    const realtimeSession = fakeRawRealtimeSession();
    const executor = new LiveKitRealtimeExecutor({
      session,
      agent: { _agentActivity: { realtimeLLMSession: realtimeSession } },
      discreteExecutor: fakeDiscreteExecutor(),
    });
    const visibleFrames = [{ id: "user-1", messages: [{ ...textUserMessage("hello") }] }] as Frame[];

    await executor.syncRuntime(syncContext({ visibleFrames }));
    await executor.syncRuntime(syncContext({ visibleFrames }));

    const creates = realtimeSession.sendEvents.filter((event) =>
      event.type === "conversation.item.create" && !event.item.id.startsWith("prj_d_")
    );
    expect(creates).toHaveLength(1);
    expect(session.replies).toEqual([undefined]);
    expect(realtimeSession.sendEvents.filter((event) => event.type === "response.create")).toHaveLength(0);
  });

  it("does not manually reply when the realtime session already has the visible user turn", async () => {
    const session = new FakeSession();
    const realtimeSession = fakeRawRealtimeSession([
      llm.ChatMessage.create({ role: "user", content: "hello" }),
    ]);
    const executor = new LiveKitRealtimeExecutor({
      session,
      agent: { _agentActivity: { realtimeLLMSession: realtimeSession } },
      discreteExecutor: fakeDiscreteExecutor(),
    });

    await executor.syncRuntime(syncContext({
      visibleFrames: [{ id: "user-1", messages: [{ ...textUserMessage("hello") }] }],
    }));

    expect(realtimeSession.sendEvents.filter((event) => event.type === "conversation.item.create")).toHaveLength(0);
    expect(session.replies).toEqual([]);
  });

  it("syncs text-only realtime dynamic context through instructions without creating a user item", async () => {
    const realtimeSession = fakeRawRealtimeSession();
    const executor = new LiveKitRealtimeExecutor({
      session: new FakeSession(),
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: realtimeSession } },
    });

    await executor.syncRuntime(
      syncContext({
        inference: inference({
          systemParts: ["You are concise."],
          dynamicParts: [
            { type: "text", text: "Known memories:" },
            { type: "data", data: ["User likes tea"], label: "memories" },
          ],
        }),
      }),
    );

    expect(realtimeSession.updateInstructions).toHaveBeenCalledWith(
      expect.stringContaining("Known memories:"),
    );
    expect(realtimeSession.updateInstructions).toHaveBeenCalledWith(
      expect.stringContaining("User likes tea"),
    );
    expect(realtimeSession.sendEvents.filter((event) =>
      event.type === "conversation.item.create" && event.item.id.startsWith("prj_d_")
    )).toHaveLength(0);
  });

  it("bootstraps history then pushes dynamic image and visible input through raw realtime events", async () => {
    const session = new FakeSession();
    const generateReply = vi.fn();
    const realtimeSession = fakeRawRealtimeSession();
    const executor = new LiveKitRealtimeExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: realtimeSession, generateReply } },
    });

    await executor.syncRuntime(
      syncContext({
        inference: inference({
          systemParts: ["You are concise."],
          history: [{ ...textUserMessage("previous text") }],
          dynamicParts: [
            { type: "text", text: "Latest camera snapshot:" },
            {
              type: "image",
              data: "data:image/jpeg;base64,abc123",
              mediaType: "image/jpeg",
              label: "latest camera sensor snapshot",
            },
          ],
        }),
        visibleFrames: [{ id: "user-1", messages: [{ ...textUserMessage("what do you see?") }] }],
      }),
    );

    expect(session.replies).toEqual([undefined]);
    expect(generateReply).not.toHaveBeenCalled();
    expect(realtimeSession.updateChatCtx).toHaveBeenCalledOnce();
    expect(realtimeSession.updateInstructions).toHaveBeenCalledWith(
      expect.stringContaining("Application-provided dynamic context"),
    );
    expect(realtimeSession.updateInstructions).toHaveBeenCalledWith(
      expect.stringContaining("Latest camera snapshot:"),
    );

    const bootstrapCtx = realtimeSession.updateChatCtx.mock.calls[0]?.[0] as llm.ChatContext;
    const bootstrapMessages = bootstrapCtx.items.filter((item): item is llm.ChatMessage => item.type === "message");
    expect(bootstrapMessages.map((message) => message.content)).toEqual([["previous text"]]);
    expect(bootstrapMessages.map((message) => message.id)).toEqual([
      expect.stringMatching(/^prj_h_/),
    ]);

    expect(realtimeSession.sendEvents).toHaveLength(2);
    expectRealtimeItemIdsWithinOpenAILimit(realtimeSession);
    expect(realtimeSession.sendEvents[0]).toMatchObject({
      type: "conversation.item.create",
      item: {
        id: expect.stringMatching(/^prj_d_/),
        role: "user",
        content: [
          {
            type: "input_text",
            text: expect.stringContaining("Latest camera snapshot:"),
          },
          {
            type: "input_image",
            image_url: "data:image/jpeg;base64,abc123",
          },
        ],
      },
    });
    expect(realtimeSession.sendEvents[1]).toMatchObject({
      type: "conversation.item.create",
      item: {
        role: "user",
        content: [{ type: "input_text", text: "what do you see?" }],
      },
    });
  });

  it("deletes the previous dynamic realtime item after the replacement is acknowledged", async () => {
    const realtimeSession = fakeRawRealtimeSession();
    const executor = new LiveKitRealtimeExecutor({
      session: new FakeSession(),
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: realtimeSession } },
    });

    await executor.syncRuntime(syncContext({
      inference: inference({
        dynamicParts: [
          { type: "text", text: "Latest camera snapshot:" },
          { type: "image", data: "data:image/jpeg;base64,first", mediaType: "image/jpeg" },
        ],
      }),
    }));
    const firstDynamicCreate = realtimeSession.sendEvents.find((event) =>
      event.type === "conversation.item.create" &&
      event.item.id.startsWith("prj_d_")
    );
    const firstDynamicId = firstDynamicCreate?.item.id;

    await executor.syncRuntime(syncContext({
      inference: inference({
        dynamicParts: [
          { type: "text", text: "Latest camera snapshot:" },
          { type: "image", data: "data:image/jpeg;base64,second", mediaType: "image/jpeg" },
        ],
      }),
    }));

    const dynamicCreates = realtimeSession.sendEvents.filter((event) =>
      event.type === "conversation.item.create" &&
      event.item.id.startsWith("prj_d_")
    );
    expect(dynamicCreates).toHaveLength(2);
    expect(dynamicCreates[1]?.item.id).not.toBe(firstDynamicId);
    expect(dynamicCreates[1]?.item.content[1]).toMatchObject({
      type: "input_image",
      image_url: "data:image/jpeg;base64,second",
    });
    expect(realtimeSession.sendEvents).toContainEqual({
      type: "conversation.item.delete",
      item_id: firstDynamicId,
    });
    expectRealtimeItemIdsWithinOpenAILimit(realtimeSession);
  });

  it("publishes current dynamic context again when a new raw realtime session appears", async () => {
    const firstRealtimeSession = fakeRawRealtimeSession();
    const secondRealtimeSession = fakeRawRealtimeSession();
    const activity = { realtimeLLMSession: firstRealtimeSession };
    const executor = new LiveKitRealtimeExecutor({
      session: new FakeSession(),
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: activity },
    });
    const context = syncContext({
      inference: inference({
        dynamicParts: [
          { type: "text", text: "Latest camera snapshot:" },
          { type: "image", data: "data:image/jpeg;base64,same", mediaType: "image/jpeg" },
        ],
      }),
    });

    await executor.syncRuntime(context);
    activity.realtimeLLMSession = secondRealtimeSession;
    await executor.syncRuntime(context);

    expect(firstRealtimeSession.sendEvents).toContainEqual(expect.objectContaining({
      type: "conversation.item.create",
      item: expect.objectContaining({ id: expect.stringMatching(/^prj_d_/) }),
    }));
    expect(secondRealtimeSession.sendEvents).toContainEqual(expect.objectContaining({
      type: "conversation.item.create",
      item: expect.objectContaining({ id: expect.stringMatching(/^prj_d_/) }),
    }));
  });

  it("keeps dynamic realtime content before a visible user message already present in history", async () => {
    const realtimeSession = fakeRawRealtimeSession();
    const executor = new LiveKitRealtimeExecutor({
      session: new FakeSession(),
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: realtimeSession } },
    });
    const userMessage = { ...textUserMessage("what do you see?") };

    await executor.syncRuntime(syncContext({
      inference: inference({
        history: [userMessage],
        dynamicParts: [
          { type: "text", text: "Latest camera snapshot:" },
          { type: "image", data: "data:image/jpeg;base64,abc123", mediaType: "image/jpeg" },
        ],
      }),
      visibleFrames: [{ id: "user-1", messages: [userMessage] }],
    }));

    const bootstrapCtx = realtimeSession.updateChatCtx.mock.calls[0]?.[0] as llm.ChatContext;
    expect(bootstrapCtx.items.filter((item) => item.type === "message")).toHaveLength(0);

    const createEvents = realtimeSession.sendEvents.filter((event) =>
      event.type === "conversation.item.create"
    );
    expect(createEvents.map((event) => event.item.id.startsWith("prj_d_"))).toEqual([
      true,
      false,
    ]);
    expect(createEvents[1]?.item.content).toEqual([
      { type: "input_text", text: "what do you see?" },
    ]);
  });

  it("restores persisted LiveKit voice transcripts into realtime ChatCtx", async () => {
    const realtimeSession = fakeRawRealtimeSession();
    const executor = new LiveKitRealtimeExecutor({
      session: new FakeSession(),
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: realtimeSession } },
    });

    await executor.syncRuntime(syncContext({
      inference: inference({
        history: [
          { ...textUserMessage("voice transcript"), source: { external: true } },
          { ...textUserMessage("typed livekit message"), source: { external: true, transport: "livekit" } },
        ],
      }),
    }));

    const contents = realtimeSession.chatCtx.items
      .filter((item): item is llm.ChatMessage => item.type === "message")
      .flatMap((message) => message.content);
    expect(contents).toEqual(["voice transcript", "typed livekit message"]);
  });

  it("does not duplicate voice transcripts already present in realtime ChatCtx", async () => {
    const realtimeSession = fakeRawRealtimeSession([
      llm.ChatMessage.create({
        role: "user",
        id: "livekit-live-transcript",
        content: ["voice transcript"],
      }),
    ]);
    const executor = new LiveKitRealtimeExecutor({
      session: new FakeSession(),
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: realtimeSession } },
    });

    await executor.syncRuntime(syncContext({
      inference: inference({
        history: [
          { ...textUserMessage("voice transcript"), source: { external: true } },
          { ...textAssistantMessage("answer transcript"), source: { external: true } },
        ],
      }),
    }));

    const messages = realtimeSession.chatCtx.items
      .filter((item): item is llm.ChatMessage => item.type === "message");
    expect(messages.map((message) => message.id)).toEqual([
      "livekit-live-transcript",
      expect.stringMatching(/^prj_h_/),
    ]);
    expect(messages.flatMap((message) => message.content)).toEqual([
      "voice transcript",
      "answer transcript",
    ]);
  });

  it("records LiveKit transcript events as inert realtime root frames", async () => {
    const session = new FakeSession();
    const frames: FrameDraft[] = [];
    const executor = new LiveKitRealtimeExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: fakeRawRealtimeSession() } },
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

    await flushPromises();

    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({
      generatorId: REALTIME_GENERATOR_ID,
      inert: true,
      messages: [
        {
          type: "user",
          content: textParts("what is the plan?"),
          text: "what is the plan?",
          audience: "broadcast",
          source: { external: true },
          speakerId: "speaker-1",
        },
      ],
    });
    expect(frames[1]).toMatchObject({
      generatorId: REALTIME_GENERATOR_ID,
      inert: true,
      messages: [
        {
          type: "assistant",
          content: textParts("Here is the plan."),
          text: "Here is the plan.",
          audience: "self",
          source: { external: true },
          messageId: "item-1",
          createdAt: 123,
        },
      ],
    });
    expectRealtimeTurnFrame(frames[2], frames[1]);
  });

  it("emits a user transcript envelope on speech start and reuses its id for the final transcript", async () => {
    const frames: FrameDraft[] = [];
    const userUpdates: any[] = [];
    const session = new FakeSession();
    const executor = new LiveKitRealtimeExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: fakeRawRealtimeSession() } },
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
      content: textParts("what is the plan?"),
      text: "what is the plan?",
      messageId,
      streamState: "complete",
      streamSeq: 1,
    });
  });

  it("enqueues realtime turn completion from response.done using the latest user transcript", async () => {
    const frames: FrameDraft[] = [];
    const session = new FakeSession();
    const realtimeSession = fakeRawRealtimeSession();
    const executor = new LiveKitRealtimeExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: realtimeSession } },
    });
    await executor.syncRuntime(syncContext({}, frames));

    session.emit("user_input_transcribed", {
      transcript: "what should I remember?",
      isFinal: true,
    });
    await flushPromises();
    realtimeSession.emit("openai_server_event_received", {
      type: "response.done",
      response: { id: "response-1" },
    });
    await flushPromises();

    expect(frames).toHaveLength(2);
    expect(frames[0]?.messages[0]).toMatchObject({
      type: "user",
      text: "what should I remember?",
    });
    expectRealtimeTurnFrame(frames[1], frames[0]);
    expect(frames[1]?.metadata).toMatchObject({
      responseDone: true,
      responseId: "response-1",
    });
  });

  it("does not duplicate realtime turn completion when response.done precedes assistant transcript flush", async () => {
    const frames: FrameDraft[] = [];
    const session = new FakeSession(new FakeTextOutput());
    const realtimeSession = fakeRawRealtimeSession();
    const executor = new LiveKitRealtimeExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: realtimeSession } },
    });
    await executor.syncRuntime(syncContext({}, frames));

    session.emit("user_input_transcribed", {
      transcript: "remember that I like tea",
      isFinal: true,
    });
    await flushPromises();
    realtimeSession.emit("openai_server_event_received", {
      type: "response.done",
      response: { id: "response-1" },
    });
    await flushPromises();
    await session.output?.transcription?.captureText("Got it.");
    session.output?.transcription?.flush();
    await flushPromises();

    expect(frames).toHaveLength(3);
    expectRealtimeTurnFrame(frames[1], frames[0]);
    expect(frames[2]?.messages[0]).toMatchObject({
      type: "assistant",
      text: "Got it.",
    });
    expect(frames.filter((frame) => frame.metadata?.type === "projector.runtime-turn")).toHaveLength(1);
  });

  it("enqueues parsed LiveKit data messages as active user frames", async () => {
    const session = new FakeSession();
    const room = new FakeRoom();
    const frames: FrameDraft[] = [];
    const executor = new LiveKitRealtimeExecutor({
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
          content: textParts("hello"),
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
    const executor = new LiveKitRealtimeExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: fakeRawRealtimeSession() } },
      onAssistantTranscriptUpdate: (update) => {
        streamUpdates.push(update);
      },
    });

    await executor.syncRuntime(syncContext({}, frames));

    await session.output?.transcription?.captureText("Hel");
    await session.output?.transcription?.captureText("lo");
    session.output?.transcription?.flush();
    await flushPromises();

    expect(frames).toHaveLength(2);
    expect(frames[0]?.inert).toBe(true);
    expectRealtimeTurnFrame(frames[1], frames[0]);
    const message = frames[0]!.messages[0] as any;
    const messageId = message.messageId;
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
    expect(message).toMatchObject({
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
    const executor = new LiveKitRealtimeExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: fakeRawRealtimeSession() } },
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
    const executor = new LiveKitRealtimeExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: fakeRawRealtimeSession() } },
    });

    await executor.syncRuntime(syncContext({}, []));

    expect(session.output?.transcription).not.toBe(originalOutput);

    executor.disconnect();

    expect(session.output?.transcription).toBe(originalOutput);
  });

  it("does not duplicate conversation_item_added when assistant stream wrapper is active", async () => {
    const session = new FakeSession(new FakeTextOutput());
    const frames: FrameDraft[] = [];
    const executor = new LiveKitRealtimeExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: fakeRawRealtimeSession() } },
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

    expect(frames).toHaveLength(2);
    expectRealtimeTurnFrame(frames[1], frames[0]);
    expect(frames.filter((frame) => frame.inert).map((frame) => frame.messages[0]?.streamState)).toEqual([
      "complete",
    ]);
  });

  it("does not emit partial transcript frames when no stream callback is configured", async () => {
    const session = new FakeSession(new FakeTextOutput());
    const frames: FrameDraft[] = [];
    const executor = new LiveKitRealtimeExecutor({
      session,
      discreteExecutor: fakeDiscreteExecutor(),
      agent: { _agentActivity: { realtimeLLMSession: fakeRawRealtimeSession() } },
    });
    await executor.syncRuntime(syncContext({}, frames));

    await session.output?.transcription?.captureText("Hel");
    await session.output?.transcription?.captureText("lo");

    expect(frames).toHaveLength(0);

    session.output?.transcription?.flush();
    await flushPromises();

    expect(frames).toHaveLength(2);
    expect(frames[0]?.messages[0]).toMatchObject({
      type: "assistant",
      content: textParts("Hello"),
      text: "Hello",
      streamState: "complete",
    });
    expectRealtimeTurnFrame(frames[1], frames[0]);
  });

  it("uses last compiled tool wins and resolves callbacks against the latest snapshot", async () => {
    const first = createAction({
      state: null,
      name: "lookup",
      description: "first",
      inputSchema: z.object({ query: z.string() }),
      run: vi.fn(() => "first-result"),
    });
    const secondRun = vi.fn(() => "second-result");
    const second = createAction({
      state: null,
      name: "lookup",
      description: "second",
      inputSchema: z.object({ query: z.string() }),
      run: secondRun,
    });
    const frames: FrameDraft[] = [];
    const realtimeSession = fakeRawRealtimeSession();
    const session = new FakeSession();
    const executor = new LiveKitRealtimeExecutor({
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
    expect(secondRun).toHaveBeenCalledWith(
      { query: "x" },
      expect.objectContaining({
        instance: expect.objectContaining({ ownerInstanceId: "" }),
      }),
    );
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
    const createActionContext = vi.fn(() => createUnboundActionContext(getState));
    const realtimeSession = fakeRawRealtimeSession();
    const executor = new LiveKitRealtimeExecutor({
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
    const executor = new LiveKitRealtimeExecutor({
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

  it("enqueues formed messages returned by tools", async () => {
    const frames: FrameDraft[] = [];
    const ping = createAction({
      state: null,
      name: "ping",
      inputSchema: z.object({}),
      run: () => textAssistantMessage("pong"),
    });
    const executor = new LiveKitRealtimeExecutor({
      session: new FakeSession(),
      discreteExecutor: fakeDiscreteExecutor(),
    });

    await executor.syncRuntime(
      syncContext(
        {
          inference: inference({
            tools: [ping],
          }),
        },
        frames,
      ),
    );

    await expect(executor.executeTool("ping", {})).resolves.toEqual(textAssistantMessage("pong"));
    expect(frames).toMatchObject([
      {
        inert: true,
        messages: [{ type: "tool", name: "ping", value: { phase: "call", input: {} } }],
      },
      {
        inert: true,
        messages: [
          {
            type: "tool",
            name: "ping",
            value: { phase: "result", value: textAssistantMessage("pong") },
          },
        ],
      },
      {
        inert: true,
        metadata: { transport: "livekit", actionResult: true },
        messages: [textAssistantMessage("pong")],
      },
    ]);
  });

  it("removes event handlers on disconnect", () => {
    const session = new FakeSession();
    const executor = new LiveKitRealtimeExecutor({
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
          { ...textUserMessage("Hi") },
          {
            type: "instance",
            kind: "state.update",
            instanceId: "root",
            stateKey: "status",
            update: { op: "patch", value: { ready: true } },
          },
          { ...textAssistantMessage("Hello") },
          { type: "tool", name: "lookup", value: { ok: true } },
          { type: "work", kind: "completion", activationId: "a", reason: "done" },
        ],
      }),
    );

    expect(rendered).toContain("## System\n\nSystem A");
    expect(rendered).toContain("## Dynamic Context\n\nDynamic B");
    expect(rendered).toContain("User: Hi");
    expect(rendered).toContain('Tool lookup: {"ok":true}');
    expect(rendered).not.toContain("state.update");
    expect(rendered).not.toContain("activationId");
  });

  it("summarizes image parts without inlining base64 data", () => {
    const rendered = buildLiveKitInstructions(
      inference({
        dynamicParts: [
          { type: "text", text: "Latest camera snapshot:" },
          {
            type: "image",
            data: "data:image/jpeg;base64,abc123",
            mediaType: "image/jpeg",
            label: "latest camera sensor snapshot",
          },
        ],
      }),
    );

    expect(rendered).toContain("Latest camera snapshot:");
    expect(rendered).toContain("mediaType=image/jpeg");
    expect(rendered).toContain("data=data URL");
    expect(rendered).not.toContain("abc123");
  });

  it("exports last-wins LiveKit tool definitions", () => {
    const definitions = buildLiveKitToolDefinitions(
      inference({
        tools: [
          createAction({ state: null, name: "same", description: "first" }),
          createAction({ state: null, name: "same", description: "last" }),
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
    realizePrompt: vi.fn((request) => ({ provider: "test", input: request.inference })),
  };
}

function fakeRealtimeSession(items: llm.ChatItem[] = []) {
  const chatCtx = llm.ChatContext.empty();
  chatCtx.items = items;
  const session = {
    chatCtx,
    updateInstructions: vi.fn(),
    updateTools: vi.fn(),
    updateChatCtx: vi.fn((chatCtx: llm.ChatContext) => {
      assertChatContextItemIdsWithinOpenAILimit(chatCtx);
      session.chatCtx = chatCtx.copy();
    }),
    generateReply: vi.fn(),
  };
  return session;
}

function fakeRawRealtimeSession(items: llm.ChatItem[] = []) {
  const chatCtx = llm.ChatContext.empty();
  chatCtx.items = items;
  const session = {
    chatCtx,
    updateInstructions: vi.fn(),
    updateTools: vi.fn(),
    updateChatCtx: vi.fn((chatCtx: llm.ChatContext) => {
      assertChatContextItemIdsWithinOpenAILimit(chatCtx);
      session.chatCtx = chatCtx.copy();
    }),
    generateReply: vi.fn(),
    handlers: new Map<string, Set<(event: unknown) => void>>(),
    sendEvents: [] as any[],
    on(event: string, handler: (event: unknown) => void): void {
      const handlers = this.handlers.get(event) ?? new Set();
      handlers.add(handler);
      this.handlers.set(event, handlers);
    },
    off(event: string, handler: (event: unknown) => void): void {
      this.handlers.get(event)?.delete(handler);
    },
    emit(event: string, payload: unknown): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(payload);
      }
    },
    sendEvent: vi.fn((event: any) => {
      session.sendEvents.push(event);
      if (event.type === "conversation.item.create") {
        assertOpenAIRealtimeItemId(event.item.id);
        const message = realtimeMessageToLiveKitMessage(event.item);
        if (message) session.chatCtx.items.push(message);
        session.emit("openai_server_event_received", {
          type: "conversation.item.created",
          item: event.item,
          previous_item_id: event.previous_item_id ?? null,
        });
      }
      if (event.type === "conversation.item.delete") {
        session.chatCtx.items = session.chatCtx.items.filter((item) => item.id !== event.item_id);
        session.emit("openai_server_event_received", {
          type: "conversation.item.deleted",
          item_id: event.item_id,
        });
      }
    }),
  };
  return session;
}

function expectRealtimeItemIdsWithinOpenAILimit(session: { sendEvents: any[]; chatCtx?: llm.ChatContext }): void {
  for (const event of session.sendEvents) {
    if (event.type === "conversation.item.create") {
      if (typeof event.item.id !== "string") {
        throw new Error(`Expected realtime create item id to be a string: ${JSON.stringify(event)}`);
      }
      expect(event.item.id.length).toBeLessThanOrEqual(32);
      expect(event.item.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
    if (event.type === "conversation.item.delete") {
      expect(event.item_id.length).toBeLessThanOrEqual(32);
      expect(event.item_id).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  }
  if (session.chatCtx) {
    for (const item of session.chatCtx.items) {
      expect(item.id.length).toBeLessThanOrEqual(32);
      expect(item.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  }
}

function assertChatContextItemIdsWithinOpenAILimit(chatCtx: llm.ChatContext): void {
  for (const item of chatCtx.items) {
    assertOpenAIRealtimeItemId(item.id);
  }
}

function assertOpenAIRealtimeItemId(itemId: string): void {
  if (itemId.length > 32) {
    throw new Error(`OpenAI Realtime item id too long: ${itemId}`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(itemId)) {
    throw new Error(`OpenAI Realtime item id contains invalid characters: ${itemId}`);
  }
}

function realtimeMessageToLiveKitMessage(item: any): llm.ChatMessage | undefined {
  if (!item || item.type !== "message") return undefined;
  const content = (item.content ?? []).flatMap((part: any) => {
    if (part.type === "input_text" || part.type === "output_text") return [part.text];
    if (part.type === "input_image") {
      return [llm.createImageContent({ image: part.image_url })];
    }
    return [];
  });
  return llm.ChatMessage.create({
    id: item.id,
    role: item.role,
    content,
  });
}

function request(overrides: Partial<ExecutorRunRequest> = {}): ExecutorRunRequest {
  return {
    generatorId: REALTIME_GENERATOR_ID,
    activationId: "activation-1",
    runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
    inference: inference(),
    enqueueFrame: enqueueTo([]),
    ...overrides,
  };
}

function inference<TDataContent = never>(
  overrides: Partial<Omit<CompiledInference<TDataContent>, "systemParts" | "dynamicParts" | "history">> & {
    systemParts?: Array<string | ContentPart<any>>;
    dynamicParts?: Array<string | ContentPart<any>>;
    history?: CompiledInference<TDataContent>["history"];
  } = {},
): CompiledInference<TDataContent> {
  return {
    ...overrides,
    tools: overrides.tools ?? [],
    retrievableStates: overrides.retrievableStates ?? [],
    history: normalizeHistory(overrides.history ?? []),
    systemParts: normalizeParts(overrides.systemParts ?? []),
    dynamicParts: normalizeParts(overrides.dynamicParts ?? []),
  };
}

function normalizeParts(parts: Array<string | ContentPart<any>>): ContentPart<any>[] {
  return parts.map((part) => typeof part === "string" ? { type: "text", text: part } : part);
}

function textParts(...texts: string[]): ContentPart<never>[] {
  return normalizeParts(texts) as ContentPart<never>[];
}

function normalizeHistory<TDataContent>(
  history: CompiledInference<TDataContent>["history"],
): CompiledInference<TDataContent>["history"] {
  return history.map(normalizeMessageContent) as CompiledInference<TDataContent>["history"];
}

function normalizeMessageContent<T>(message: T): T {
  if (
    message &&
    typeof message === "object" &&
    ((message as { type?: unknown }).type === "user" || (message as { type?: unknown }).type === "assistant") &&
    typeof (message as { content?: unknown }).content === "string"
  ) {
    const text = (message as unknown as { content: string }).content;
    return {
      ...message,
      content: [{ type: "text", text }],
    };
  }
  return message;
}

function syncContext(
  overrides: Partial<RuntimeSyncContext> = {},
  frames: FrameDraft[] = [],
): RuntimeSyncContext {
  const machine = overrides.machine ?? fakeMachine(frames);
  return {
    machine,
    runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
    generator: {
      id: REALTIME_GENERATOR_ID,
      kind: "generator",
      runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
    },
    inference: inference(),
    createActionContext: () => createUnboundActionContext(),
    enqueueFrame: (frame) => machine.enqueueFrame(frame),
    ...overrides,
    visibleFrames: (overrides.visibleFrames ?? []).map((frame) => ({
      ...frame,
      messages: frame.messages.map(normalizeMessageContent),
    })),
  };
}

function fakeMachine(frames: FrameDraft[]): RuntimeSyncContext["machine"] {
  const storedFrames: Frame[] = [];
  return {
    id: "machine",
    root: { id: "root", node: createNode({ key: "root" }) },
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

function expectRealtimeTurnFrame(
  frame: FrameDraft | undefined,
  sourceFrame: FrameDraft | undefined,
): void {
  const sourceFrameId = (sourceFrame as Frame | undefined)?.id;
  expect(sourceFrameId).toBeTruthy();
  expect(frame).toMatchObject({
    generatorId: REALTIME_GENERATOR_ID,
    runtimeInstanceId: REALTIME_GENERATOR_ID,
    activationId: expect.stringMatching(/^activation:realtime:/),
    metadata: {
      type: "projector.runtime-turn",
      runtimeInstanceId: REALTIME_GENERATOR_ID,
      sourceFrameId,
      completionReason: "end-turn",
      mode: "voice",
      transport: "livekit",
      realtimeTurn: true,
    },
    messages: [
      {
        type: "work",
        kind: "activation",
        runtimeInstanceId: REALTIME_GENERATOR_ID,
        generatorId: REALTIME_GENERATOR_ID,
        sourceFrameId,
        concurrencyKey: REALTIME_GENERATOR_ID,
        concurrency: "serial",
      },
      {
        type: "work",
        kind: "completion",
        sourceFrameId,
        reason: "end-turn",
      },
    ],
  });
  expect(frame?.messages[1]).toMatchObject({
    activationId: (frame?.messages[0] as { activationId?: string } | undefined)?.activationId,
  });
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
