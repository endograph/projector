import { describe, expect, it, vi } from "vitest";
import {
  createGetStateAction,
  type CompiledInference,
  type ExecutorRunRequest,
  type Frame,
  type FrameDraft,
} from "@projectors/core";
import { z } from "zod";
import {
  AiSdkExecutor,
  buildAiSdkMessages,
  buildAiSdkSystem,
  buildAiSdkTools,
} from "../executor.ts";
import type { AiSdkExecutorConfig } from "../types.ts";

describe("AI SDK prompt rendering", () => {
  it("builds system prompt from system and dynamic parts", () => {
    expect(
      buildAiSdkSystem(
        inference({
          systemParts: ["You are concise.", "Use tools carefully."],
          dynamicParts: ["Mode: text."],
        }),
      ),
    ).toBe(
      [
        "## System",
        "",
        "You are concise.",
        "",
        "Use tools carefully.",
        "",
        "## Dynamic Context",
        "",
        "Mode: text.",
      ].join("\n"),
    );
  });

  it("converts actor history into AI SDK model messages", () => {
    expect(
      buildAiSdkMessages(
        inference({
          history: [
            { type: "user", text: "hello" },
            { type: "assistant", text: "hi" },
            { type: "tool", name: "lookup", value: { ok: true } },
            { type: "tool", name: "search", text: "done" },
          ],
        }),
      ),
    ).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: 'Tool lookup: {"ok":true}' },
      { role: "user", content: "Tool search: done" },
    ]);
  });
});

describe("AiSdkExecutor", () => {
  it("calls generateText with model, prompt, signal, model options, and stopWhen for tools", async () => {
    const model = fakeModel();
    const signal = new AbortController().signal;
    const generate = vi.fn(async () => result({ text: "hello" }));
    const requestInput = request({
      signal,
      inference: inference({
        systemParts: ["system"],
        dynamicParts: ["dynamic"],
        history: [{ type: "user", text: "hi" }],
        tools: [{ state: null, name: "lookup", inputSchema: z.object({ query: z.string() }) }],
      }),
    });
    const executor = new AiSdkExecutor({
      model,
      generateText: generate as never,
      maxOutputTokens: 100,
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      seed: 123,
      providerOptions: { openai: { reasoningEffort: "low" } },
      toolChoice: "auto",
      maxSteps: 7,
    });

    await executor.run(requestInput);

    expect(generate).toHaveBeenCalledOnce();
    const generateInput = (generate.mock.calls as any)[0]?.[0];
    expect(generateInput).toMatchObject({
      model,
      system: "## System\n\nsystem\n\n## Dynamic Context\n\ndynamic",
      messages: [{ role: "user", content: "hi" }],
      abortSignal: signal,
      maxOutputTokens: 100,
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      seed: 123,
      providerOptions: { openai: { reasoningEffort: "low" } },
      toolChoice: "auto",
    });
    expect(generateInput.tools.lookup).toBeDefined();
    expect(generateInput.stopWhen).toBeDefined();
  });

  it("returns generated text for projector-owned output mapping", async () => {
    const frames: FrameDraft[] = [];
    const raw = result({
      text: "Final answer.",
      steps: [{ stepType: "initial" }],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      finishReason: "stop",
    });
    const executor = new AiSdkExecutor({
      model: fakeModel(),
      generateText: vi.fn(async () => raw) as never,
    });

    const output = await executor.run(request({ enqueueFrame: enqueueTo(frames) }));

    expect(output.completionReason).toBe("done");
    expect(output.value).toBe("Final answer.");
    expect(output.frames).toBeUndefined();
    expect(frames).toEqual([]);
  });

  it("passes request output schema to generateText", async () => {
    const frames: FrameDraft[] = [];
    const generate = vi.fn(async () => result({ text: "Structured answer." }));
    const schema = z.object({ type: z.literal("assistant"), text: z.string() });
    const executor = new AiSdkExecutor({
      model: fakeModel(),
      generateText: generate as never,
    });

    await executor.run(
      request({
        output: { schema },
        enqueueFrame: enqueueTo(frames),
      }),
    );

    expect((generate.mock.calls as any)[0]?.[0]?.experimental_output.name).toBe("object");
    expect(frames).toEqual([]);
  });

  it("emits stream updates out-of-band and returns the final text", async () => {
    const frames: FrameDraft[] = [];
    const streamUpdates: any[] = [];
    const generate = vi.fn(async () => result({ text: "unused" }));
    const stream = vi.fn(() => streamResult(["Hel", "lo"]));
    const executor = new AiSdkExecutor({
      model: fakeModel(),
      generateText: generate as never,
      streamText: stream as never,
      stream: true,
      onStreamUpdate: (update) => {
        streamUpdates.push(update);
      },
    });

    const output = await executor.run(request({ enqueueFrame: enqueueTo(frames) }));
    await flushPromises();

    expect(output.completionReason).toBe("done");
    expect(output.value).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledOnce();
    expect(new Set(streamUpdates.map((update) => update.messageId)).size).toBe(1);
    const messageId = streamUpdates[0]?.messageId;
    expect(streamUpdates.map((update) => update.text)).toEqual(["", "Hel", "Hello"]);
    expect(streamUpdates.map((update) => update.delta)).toEqual([undefined, "Hel", "lo"]);
    expect(streamUpdates.map((update) => update.streamState)).toEqual([
      "streaming",
      "streaming",
      "streaming",
    ]);
    expect(streamUpdates.map((update) => update.streamSeq)).toEqual([0, 1, 2]);
    expect(output.frames).toEqual([
      {
        messages: [
          {
            type: "assistant",
            text: "Hello",
            messageId,
            streamState: "complete",
            streamSeq: 3,
          },
        ],
      },
    ]);
    expect(frames).toEqual([]);
  });

  it("does not enqueue a frame when generated text is empty", async () => {
    const frames: FrameDraft[] = [];
    const executor = new AiSdkExecutor({
      model: fakeModel(),
      generateText: vi.fn(async () => result({ text: "" })) as never,
    });

    const output = await executor.run(request({ enqueueFrame: enqueueTo(frames) }));

    expect(output.completionReason).toBe("done");
    expect(output.value).toBeUndefined();
    expect(output.frames).toBeUndefined();
    expect(frames).toEqual([]);
  });

  it("converts projected actions into tools and executes action.run with fresh context", async () => {
    const actionRun = vi.fn((input, context) => ({ input, context }));
    const requestInput = request({
      inference: inference({
        tools: [
          {
            state: null,
            name: "lookup",
            description: "Look something up.",
            inputSchema: z.object({ query: z.string() }),
            run: actionRun,
          },
        ],
      }),
    });

    const tools = buildAiSdkTools(requestInput, config());
    const output = await (tools.lookup as any).execute({ query: "x" }, { toolCallId: "call-1" });

    expect((tools.lookup as any).description).toBe("Look something up.");
    expect(actionRun).toHaveBeenCalledWith({ query: "x" }, {});
    expect(output).toEqual({ input: { query: "x" }, context: {} });
  });

  it("uses request-created action contexts for projected tools", async () => {
    const context = { state: { count: 1 } };
    const actionRun = vi.fn((input, ctx) => ({ input, ctx }));
    const requestInput = request({
      createActionContext: vi.fn(() => context),
      inference: inference({
        tools: [{ state: null, name: "lookup", run: actionRun }],
      }),
    });

    const tools = buildAiSdkTools(requestInput, config());
    await expect((tools.lookup as any).execute({ query: "x" })).resolves.toEqual({
      input: { query: "x" },
      ctx: context,
    });
    expect(requestInput.createActionContext).toHaveBeenCalledWith(
      requestInput.inference.tools[0],
    );
  });

  it("enqueues formed messages returned by actions", async () => {
    const frames: FrameDraft[] = [];
    const tools = buildAiSdkTools(
      request({
        enqueueFrame: enqueueTo(frames),
        inference: inference({
          tools: [
            {
              state: null,
              name: "announce",
              run: () => ({ type: "assistant", text: "from tool", audience: "broadcast" }),
            },
          ],
        }),
      }),
      config(),
    );

    await (tools.announce as any).execute({});

    expect(frames).toMatchObject([
      {
        generatorId: "generator-1",
        runtimeInstanceId: "runtime-1",
        activationId: "activation-1",
        messages: [{ type: "assistant", text: "from tool", audience: "broadcast" }],
      },
    ]);
  });

  it("executes projected getState actions through action context", async () => {
    const getState = vi.fn((address: string) => ({ address, value: 1 }));
    const getStateAction = createGetStateAction();
    const requestInput = request({
      createActionContext: vi.fn(() => ({ getState })),
      inference: inference({
        tools: [getStateAction],
        retrievableStates: [
          { address: "memory", target: { instanceId: "r", stateKey: "memory" } },
        ],
      }),
    });
    const tools = buildAiSdkTools(requestInput, config());

    await expect((tools.getState as any).execute({ address: "memory" })).resolves.toEqual({
      address: "memory",
      value: 1,
    });
    expect(getState).toHaveBeenCalledWith("memory");
    expect(requestInput.createActionContext).toHaveBeenCalledWith(getStateAction);
  });

  it("uses runAction override when provided", async () => {
    const actionRun = vi.fn();
    const runAction = vi.fn(() => "override");
    const requestInput = request({
      inference: inference({
        tools: [{ state: null, name: "lookup", run: actionRun }],
      }),
    });

    const tools = buildAiSdkTools(requestInput, config({ runAction }));
    await expect((tools.lookup as any).execute({ query: "x" }, { toolCallId: "call-1" })).resolves.toBe(
      "override",
    );

    expect(actionRun).not.toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledWith({
      action: requestInput.inference.tools[0],
      input: { query: "x" },
      context: {},
      request: requestInput,
      aiSdkContext: { toolCallId: "call-1" },
    });
  });

  it("uses the last action for duplicate tool names", async () => {
    const firstRun = vi.fn(() => "first");
    const secondRun = vi.fn(() => "second");
    const tools = buildAiSdkTools(
      request({
        inference: inference({
          tools: [
            { state: null, name: "lookup", description: "first", run: firstRun },
            { state: null, name: "lookup", description: "second", run: secondRun },
          ],
        }),
      }),
      config(),
    );

    await expect((tools.lookup as any).execute({})).resolves.toBe("second");
    expect((tools.lookup as any).description).toBe("second");
    expect(firstRun).not.toHaveBeenCalled();
  });

  it("returns cancelled for already aborted requests and abort errors", async () => {
    const controller = new AbortController();
    controller.abort();
    const alreadyAborted = new AiSdkExecutor({
      model: fakeModel(),
      generateText: vi.fn(async () => result({ text: "unused" })) as never,
    });

    await expect(alreadyAborted.run(request({ signal: controller.signal }))).resolves.toEqual({
      completionReason: "cancelled",
    });

    const aborting = new AiSdkExecutor({
      model: fakeModel(),
      generateText: vi.fn(async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }) as never,
    });

    await expect(aborting.run(request())).resolves.toEqual({ completionReason: "cancelled" });
  });
});

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

function request(overrides: Partial<ExecutorRunRequest> = {}): ExecutorRunRequest {
  return {
    generatorId: "generator-1",
    activationId: "activation-1",
    runtimeInstanceId: "runtime-1",
    inference: inference({
      history: [{ type: "user", text: "hello" }],
    }),
    enqueueFrame: enqueueTo([]),
    ...overrides,
  };
}

function enqueueTo(frames: FrameDraft[]) {
  return async (frame: FrameDraft): Promise<Frame> => {
    frames.push(frame);
    return { id: `frame-${frames.length}`, ...frame };
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function config(overrides: Partial<AiSdkExecutorConfig> = {}): AiSdkExecutorConfig {
  return { model: fakeModel(), ...overrides };
}

function fakeModel() {
  return "fake-model" as never;
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    text: "",
    steps: [],
    usage: undefined,
    finishReason: "stop",
    ...overrides,
  };
}

function streamResult(chunks: string[]) {
  return {
    text: Promise.resolve(chunks.join("")),
    steps: Promise.resolve([{ stepType: "initial" }]),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
    finishReason: Promise.resolve("stop"),
    textStream: (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    })(),
  };
}
