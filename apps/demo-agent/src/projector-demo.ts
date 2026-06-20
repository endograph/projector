import { z } from "zod";
import {
  ROOT_RUNTIME_INSTANCE_ID,
  appendState,
  applyStaticProjection,
  createAction,
  createCharter,
  createCommand,
  createHistoryProjectionFunction,
  createNode,
  createProjectionFunction,
  createRoot,
  hydrateInstance,
  inspectCompiledProjectionTree,
  imageContent,
  messagesBeforeLastCompletion,
  messagesSinceLastCompletion,
  patchState,
  resolveStates,
  replaceState,
  serializeInstance,
  textContent,
  type CompiledProjectionTree,
  type Charter,
  type Executor,
  type Generator,
  type Instance,
  type SerializedInstance,
} from "@projectors/core";
import {
  createMachineClientSnapshot,
  realizeClientInstances,
  type MachineClientSnapshot,
  type MachineSyncState,
} from "@projectors/core/client";

const demoStateSchema = z.object({
  name: z.string().optional(),
  themeHue: z.number(),
  favorites: z.array(z.string()),
  turns: z.number(),
});

export type DemoState = z.infer<typeof demoStateSchema>;

const agentControlsStateSchema = z.object({
  liveMode: z.boolean(),
  cameraEnabled: z.boolean(),
  memoryEnabled: z.boolean(),
  streamingEnabled: z.boolean(),
  testCounter: z.number(),
});

export type AgentControlsState = z.infer<typeof agentControlsStateSchema>;

const memorySchema = z.object({
  text: z.string().min(1).max(500),
});

const memoriesStateSchema = z.array(memorySchema);

export type Memory = z.infer<typeof memorySchema>;
export type MemoriesState = z.infer<typeof memoriesStateSchema>;

export type DemoMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  frameId: string;
  mode?: "text" | "voice";
  streamState?: "streaming" | "complete" | "error";
  streamSeq?: number;
};

export type DemoClientSnapshot = MachineClientSnapshot & {
  projectionTree: CompiledProjectionTree;
};

export type CameraSensorImage = {
  dataUrl: string;
  mimeType: "image/jpeg";
  capturedAt: number;
  width: number;
  height: number;
  participantIdentity: string;
  trackSid: string;
};

export type CameraSensorDataSource = {
  latestImage(): CameraSensorImage | undefined;
};

let cameraSensorDataSource: CameraSensorDataSource | undefined;

const demoState = {
  key: "demo",
  schema: demoStateSchema,
  init: {
    themeHue: 126,
    favorites: [],
    turns: 0,
  } satisfies DemoState,
  projection: "dynamic" as const,
};

const agentControlsState = {
  key: "agentControls",
  schema: agentControlsStateSchema,
  init: {
    liveMode: false,
    cameraEnabled: false,
    memoryEnabled: false,
    streamingEnabled: true,
    testCounter: 0,
  } satisfies AgentControlsState,
  projection: "dynamic" as const,
};

const memoriesState = {
  key: "memories",
  schema: memoriesStateSchema,
  init: [] satisfies MemoriesState,
  projection: "dynamic" as const,
};

export const setVoiceEnabled = createCommand({
  state: agentControlsState,
  name: "setVoiceEnabled",
  description: "Toggle voice mode for the demo session.",
  inputSchema: z.object({ enabled: z.boolean() }),
  run: ({ enabled }, ctx) => {
    ctx.updateState?.(patchState({ liveMode: enabled }));
  },
});

export const projectCameraSensorData = createProjectionFunction({
  name: "projectCameraSensorData",
  method: (_ctx, draft, source) => {
    applyStaticProjection(draft, source, {
      mode: "augment",
      instructions: "dynamic",
      tools: "hidden",
    });

    const image = cameraSensorDataSource?.latestImage();
    if (image) {
      draft.dynamicParts.push(textContent(renderCameraSensorImage(image)));
      draft.dynamicParts.push(
        imageContent(image.dataUrl, {
          mediaType: image.mimeType,
          label: "latest camera sensor snapshot",
        }),
      );
    } else {
      draft.dynamicParts.push(textContent("Camera sensor is enabled, but no camera snapshot has been sampled yet."));
    }
  },
});

export const cameraSensorNode = createNode({
  key: "cameraSensor",
  name: "CameraSensorNode",
  instructions:
    "The user's camera is enabled. Use the latest camera snapshot only when relevant.",
  projection: projectCameraSensorData,
});

export const setCameraEnabled = createCommand({
  state: agentControlsState,
  name: "setCameraEnabled",
  description: "Toggle camera sampling in live mode.",
  inputSchema: z.object({ enabled: z.boolean() }),
  run: ({ enabled }, ctx) => {
    const state = agentControlsStateSchema.parse(ctx.state);
    ctx.updateState?.(patchState({ cameraEnabled: enabled }));
    if (state.cameraEnabled === enabled) return;
    if (enabled) {
      ctx.instance.spawn(cameraSensorNode);
    } else {
      ctx.instance.cede(cameraSensorNode);
    }
  },
});

export const setMemoryEnabled = createCommand({
  state: agentControlsState,
  name: "setMemoryEnabled",
  description: "Toggle durable memory extraction for the demo session.",
  inputSchema: z.object({ enabled: z.boolean() }),
  run: ({ enabled }, ctx) => {
    const state = agentControlsStateSchema.parse(ctx.state);
    ctx.updateState?.(patchState({ memoryEnabled: enabled }));
    if (state.memoryEnabled === enabled) return;
    if (enabled) {
      ctx.instance.spawn(memoryMemberNode);
    } else {
      ctx.instance.cede(memoryMemberNode);
    }
  },
});

export const setStreamingEnabled = createCommand({
  state: agentControlsState,
  name: "setStreamingEnabled",
  description: "Toggle streaming-style assistant output.",
  inputSchema: z.object({ enabled: z.boolean() }),
  run: ({ enabled }, ctx) => {
    ctx.updateState?.(patchState({ streamingEnabled: enabled }));
  },
});

export const incrementTestCounter = createCommand({
  state: agentControlsState,
  name: "incrementTestCounter",
  description: "Increment the agent controls test counter.",
  inputSchema: z.object({ amount: z.number().default(1) }),
  run: ({ amount }, ctx) => {
    const state = agentControlsStateSchema.parse(ctx.state);
    ctx.updateState?.(patchState({ testCounter: state.testCounter + amount }));
  },
});

export const setThemeHue = createCommand({
  state: demoState,
  name: "setThemeHue",
  description: "Change the terminal accent hue.",
  inputSchema: z.object({ hue: z.number().min(0).max(360) }),
  run: ({ hue }, ctx) => {
    ctx.updateState?.(patchState({ themeHue: hue }));
  },
});

export const pingTool = createAction({
  state: null,
  name: "ping",
  description: "A projected provider tool placeholder.",
  inputSchema: z.object({ text: z.string().optional() }),
});

export const updateDemoState = createAction({
  state: demoState,
  name: "updateDemoState",
  description:
    "Update durable demo state when the user shares a name or favorite.",
  inputSchema: z.object({
    name: z.string().min(1).optional(),
    favorite: z
      .object({
        kind: z.string().min(1),
        value: z.string().min(1),
      })
      .optional(),
  }),
  run: ({ name, favorite }, ctx) => {
    const state = demoStateSchema.parse(ctx.state);
    const next: DemoState = { ...state };

    if (name) {
      next.name = capitalize(name.trim());
    }
    if (favorite) {
      next.favorites = [
        ...next.favorites,
        `${favorite.kind.trim().toLowerCase()}: ${favorite.value.trim().replace(/[.!?]+$/, "")}`,
      ].slice(-6);
    }

    ctx.updateState?.(replaceState(next));
    return "Demo state updated.";
  },
});

export const saveMemories = createAction({
  state: memoriesState,
  name: "saveMemories",
  description:
    "Save durable user memories extracted from recent conversation messages.",
  inputSchema: z.object({
    memories: z.array(memorySchema).max(10),
  }),
  run: ({ memories }, ctx) => {
    const existing = memoriesStateSchema.parse(ctx.state);
    const additions = newMemories(existing, memories);
    const [firstAddition, ...remainingAdditions] = additions;
    if (firstAddition) {
      ctx.updateState?.(appendState(firstAddition, ...remainingAdditions));
    }
    return additions.length === 0
      ? "No new memories saved."
      : `Saved ${additions.length} memories.`;
  },
});

export const memoryHistoryProjection = createHistoryProjectionFunction({
  name: "memory",
  method: (ctx) => {
    const previousMessages = messagesBeforeLastCompletion(ctx);
    const newMessages = messagesSinceLastCompletion(ctx);
    const memories = memoriesStateSchema.safeParse(ctx.states.memories).success
      ? (ctx.states.memories as MemoriesState)
      : [];
    const prompt = [
      "Below is a conversation log between a user and an agent.",
      "Analyze the new messages and call saveMemories with any durable new memories.",
      "",
      "Rules:",
      "- Save only stable user facts, preferences, names, and recurring context likely to help in future unrelated conversations.",
      "- When uncertain, save nothing.",
      "- Ignore one-off tasks, temporary details, and assistant claims.",
      "- Do not duplicate current memories.",
      "- If there are no new durable memories, do not call any tool.",
      "",
      "Current memories:",
      renderMemories(memories),
      "",
      "Conversation history before the last memory update:",
      renderActorMessages(previousMessages),
      "",
      "New messages since the last memory update:",
      renderActorMessages(newMessages),
    ].join("\n");

    return [
      {
        type: "user",
        content: [textContent(prompt)],
        text: prompt,
      },
    ];
  },
});

export const memoryMemberNode = createNode({
  key: "memory",
  name: "MemoryNode",
  instructions:
    "Maintain durable user memories. Save only concise, stable, generally useful user facts. Do not create a memory for every message.",
  state: memoriesState,
  tools: [saveMemories],
  projection: { mode: "replace" },
  runtime: {
    type: "worker",
    trigger: { type: "parent-completion" },
    concurrency: "serial",
    activationHistory: "snapshot",
    historyProjection: "memory",
  },
});

export const agentControlsMemberNode = createNode({
  key: "agentControls",
  name: "Agent Controls",
  instructions:
    "Expose client commands for voice, camera, streaming, and theme controls.",
  state: agentControlsState,
  commands: [
    setVoiceEnabled,
    setCameraEnabled,
    setMemoryEnabled,
    setStreamingEnabled,
    incrementTestCounter,
  ],
  projection: { instructions: "hidden", tools: "hidden" },
});

export const demoBaseNode = createNode({
  key: "demoBase",
  name: "Projector Demo Agent",
  instructions:
    "You are a compact demo assistant. Be direct, remember small facts, and explain what changed in state. Call updateDemoState when the user shares their name or a favorite.",
  state: demoState,
  tools: [pingTool, updateDemoState],
  commands: [setThemeHue],
  members: [agentControlsMemberNode],
  projection: {
    mode: "augment",
    instructions: "system",
    tools: "provider-static",
  },
});

const executor: Executor = {
  run: async () => ({ completionReason: "done" }),
  realizePrompt: (request) => ({ provider: "demo", input: request.inference }),
};

export function createDemoCharter(
  options: { executor?: Executor; cameraSensor?: CameraSensorDataSource } = {},
): Charter {
  if ("cameraSensor" in options) {
    cameraSensorDataSource = options.cameraSensor;
  }
  return createCharter({
    key: "projector-demo",
    version: "1",
    executor: options.executor ?? executor,
    nodes: [
      demoBaseNode,
      memoryMemberNode,
      agentControlsMemberNode,
      cameraSensorNode,
    ],
    tools: [pingTool, updateDemoState, saveMemories],
    commands: [
      setVoiceEnabled,
      setCameraEnabled,
      setMemoryEnabled,
      setStreamingEnabled,
      incrementTestCounter,
      setThemeHue,
    ],
    states: [
      demoBaseNode.state!,
      memoryMemberNode.state!,
      agentControlsMemberNode.state!,
    ],
    projections: [projectCameraSensorData],
    historyProjections: [memoryHistoryProjection],
  });
}

export function createInitialDemoInstance(): Instance {
  const demoBase: Instance = {
    id: `demo-${crypto.randomUUID()}`,
    node: demoBaseNode,
  };
  const root = createRoot([demoBase]);
  resolveStates(root);
  return root;
}

export function createInitialSerializedInstance(): SerializedInstance {
  return serializeDemoInstance(createInitialDemoInstance());
}

export function hydrateDemoInstance(serialized: SerializedInstance): Instance {
  const instance = hydrateInstance(serialized, createDemoCharter());
  resolveStates(instance);
  return instance;
}

export function serializeDemoInstance(instance: Instance): SerializedInstance {
  resolveStates(instance);
  return serializeInstance(instance, createDemoCharter());
}

export function getDemoRootGenerator(_instance: Instance): Generator {
  const runtimeInstanceId = ROOT_RUNTIME_INSTANCE_ID;
  return {
    id: runtimeInstanceId,
    kind: "primary",
    runtimeInstanceId,
  };
}

export function createDemoClientSnapshot(
  serialized: SerializedInstance,
  syncState: MachineSyncState = { recentCommandResidue: [] },
): DemoClientSnapshot {
  const instance = hydrateDemoInstance(serialized);
  return {
    ...createMachineClientSnapshot(realizeClientInstances(instance), syncState),
    projectionTree: inspectCompiledProjectionTree(instance, {
      charter: createDemoCharter(),
    }),
  };
}

export function getDemoState(instance: Instance): DemoState {
  return demoStateSchema.parse(readResolvedState(instance, "demo"));
}

export function setDemoState(instance: Instance, next: DemoState): void {
  demoStateSchema.parse(next);
  writeResolvedState(instance, "demo", next);
}

export function getAgentControlsState(instance: Instance): AgentControlsState {
  return agentControlsStateSchema.parse(
    readResolvedState(instance, "agentControls"),
  );
}

export function setAgentControlsState(
  instance: Instance,
  next: AgentControlsState,
): void {
  agentControlsStateSchema.parse(next);
  writeResolvedState(instance, "agentControls", next);
}

export function getMemoriesState(instance: Instance): MemoriesState {
  return memoriesStateSchema.parse(readResolvedState(instance, "memories"));
}

export function setMemoriesState(
  instance: Instance,
  next: MemoriesState,
): void {
  memoriesStateSchema.parse(next);
  writeResolvedState(instance, "memories", next);
}

function readResolvedState(instance: Instance, key: string): unknown {
  const state = resolveStates(instance).find(
    (candidate) => candidate.address.stateKey === key,
  );
  if (!state) {
    throw new Error(`Unknown demo state "${key}"`);
  }
  return state.container.value;
}

function writeResolvedState(
  instance: Instance,
  key: string,
  value: unknown,
): void {
  const state = resolveStates(instance).find(
    (candidate) => candidate.address.stateKey === key,
  );
  if (!state) {
    throw new Error(`Unknown demo state "${key}"`);
  }
  state.container.value = value;
}

function newMemories(
  existing: MemoriesState,
  next: MemoriesState,
): MemoriesState {
  const seen = new Set(
    existing.map((memory) => normalizeMemoryText(memory.text)),
  );
  const additions: MemoriesState = [];
  for (const memory of next) {
    const text = memory.text.trim();
    const normalized = normalizeMemoryText(text);
    if (!text || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    additions.push({ text });
  }
  return additions;
}

function normalizeMemoryText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .toLowerCase();
}

function renderMemories(memories: MemoriesState): string {
  if (memories.length === 0) {
    return "(none)";
  }
  return memories
    .map((memory, index) => `${index + 1}. ${memory.text}`)
    .join("\n");
}

function renderCameraSensorImage(image: CameraSensorImage): string {
  return [
    "Latest camera sensor snapshot:",
    `- capturedAt: ${new Date(image.capturedAt).toISOString()}`,
    `- mimeType: ${image.mimeType}`,
    `- dimensions: ${image.width}x${image.height}`,
    `- participant: ${image.participantIdentity}`,
    `- trackSid: ${image.trackSid}`,
    "- image: attached as native multimodal content",
  ].join("\n");
}

function renderActorMessages(
  messages: Array<{
    type: string;
    text?: string;
    name?: string;
    value?: unknown;
  }>,
): string {
  if (messages.length === 0) {
    return "(none)";
  }
  return messages
    .map((message) => {
      if (message.type === "user") return `User: ${message.text ?? ""}`;
      if (message.type === "assistant")
        return `Assistant: ${message.text ?? ""}`;
      if (message.type === "tool")
        return `Tool ${message.name ?? "unknown"}: ${message.text ?? stringifyValue(message.value)}`;
      return `${message.type}: ${stringifyValue(message)}`;
    })
    .join("\n");
}

function stringifyValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}
