import { z } from "zod";
import {
  ROOT_GENERATOR_ID,
  actionResult,
  appendState,
  createAction,
  createCharter,
  createComputedPart,
  createHistoryProjectionFunction,
  createLayout,
  createNode,
  createRoot,
  createSlot,
  createSourceInstance,
  createState,
  hydrateInstance,
  inspectCompiledProjectionTree,
  imageContent,
  messages,
  messagesBeforeLastCompletion,
  messagesSinceLastCompletion,
  patchState,
  recencyRegion,
  resolveStates,
  serializeInstance,
  textAssistantMessage,
  textContent,
  type CompiledProjectionTree,
  type Charter,
  type GeneratorId,
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
  themeHue: z.number(),
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

const demoParamsSchema = z.object({
  sessionId: z.string(),
});

type DemoParamsSchema = typeof demoParamsSchema;

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
  projectionTree: CompiledProjectionTree<any>;
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

const demoState = createState({
  key: "demo",
  schema: demoStateSchema,
  init: {
    themeHue: 126,
    turns: 0,
  } satisfies DemoState,
  projection: { slot: recencyRegion },
});

const agentControlsState = createState({
  key: "agentControls",
  schema: agentControlsStateSchema,
  init: {
    liveMode: false,
    cameraEnabled: false,
    memoryEnabled: false,
    streamingEnabled: true,
    testCounter: 0,
  } satisfies AgentControlsState,
  projection: { slot: recencyRegion },
});

const memoriesState = createState({
  key: "memories",
  schema: memoriesStateSchema,
  init: [] satisfies MemoriesState,
  projection: { slot: recencyRegion },
});

export const setVoiceEnabled = createAction({
  state: agentControlsState,
  name: "setVoiceEnabled",
  description: "Toggle voice mode for the demo session.",
  inputSchema: z.object({ enabled: z.boolean() }),
  run: ({ enabled }, ctx) => {
    ctx.updateState?.(patchState({ liveMode: enabled }));
  },
});

export const enableLiveMode = createAction({
  state: agentControlsState,
  name: "enableLiveMode",
  description: "Enable live voice mode for the demo session.",
  inputSchema: z.object({}),
  run: (_input, ctx) => {
    const state = agentControlsStateSchema.parse(ctx.state);
    if (!state.liveMode) {
      ctx.updateState?.(patchState({ liveMode: true }));
    }
    return state.liveMode ? "Live mode is already enabled." : "Live mode enabled.";
  },
});

export const cameraSnapshotPart = createComputedPart({
  name: "cameraSnapshot",
  slot: recencyRegion,
  compute: () => {
    const image = cameraSensorDataSource?.latestImage();
    if (!image) {
      return "Camera sensor is enabled, but no camera snapshot has been sampled yet.";
    }
    return [
      textContent(renderCameraSensorImage(image)),
      imageContent(image.dataUrl, {
        mediaType: image.mimeType,
        label: "latest camera sensor snapshot",
      }),
    ];
  },
});

export const cameraSensorNode = createNode({
  key: "cameraSensor",
  name: "CameraSensorNode",
  instructions:
    "The user's camera is enabled. Use the latest camera snapshot only when relevant. When asked about the camera, answer directly from the currently available snapshot. Do not say you will check or look later; if no usable snapshot is available, say you cannot see the current camera view.",
  parts: [cameraSnapshotPart],
});

export const setCameraEnabled = createAction({
  state: agentControlsState,
  name: "setCameraEnabled",
  description: "Toggle camera sampling in live mode.",
  inputSchema: z.object({ enabled: z.boolean() }),
  run: ({ enabled }, ctx) => {
    const state = agentControlsStateSchema.parse(ctx.state);
    if (state.cameraEnabled !== enabled) {
      ctx.updateState?.(patchState({ cameraEnabled: enabled }));
    }
    if (enabled) {
      ctx.instance.cede(cameraSensorNode);
      ctx.instance.spawn(cameraSensorNode);
    } else {
      ctx.instance.cede(cameraSensorNode);
    }
  },
});

export const enableCamera = createAction({
  state: agentControlsState,
  name: "enableCamera",
  description: "Enable camera sampling for the demo session.",
  inputSchema: z.object({}),
  run: (_input, ctx) => {
    const state = agentControlsStateSchema.parse(ctx.state);
    if (!state.cameraEnabled) {
      ctx.updateState?.(patchState({ cameraEnabled: true }));
    }
    ctx.instance.cede(cameraSensorNode);
    ctx.instance.spawn(cameraSensorNode);
    return state.cameraEnabled ? "Camera is already enabled." : "Camera enabled.";
  },
});

export const setMemoryEnabled = createAction({
  state: agentControlsState,
  name: "setMemoryEnabled",
  description: "Toggle durable memory extraction for the demo session.",
  inputSchema: z.object({ enabled: z.boolean() }),
  run: ({ enabled }, ctx) => {
    const state = agentControlsStateSchema.parse(ctx.state);
    if (state.memoryEnabled !== enabled) {
      ctx.updateState?.(patchState({ memoryEnabled: enabled }));
    }
    if (enabled) {
      ctx.instance.cede(memoryMemberNode);
      ctx.instance.spawn(memoryMemberNode);
    } else {
      ctx.instance.cede(memoryMemberNode);
    }
  },
});

export const setStreamingEnabled = createAction({
  state: agentControlsState,
  name: "setStreamingEnabled",
  description: "Toggle streaming-style assistant output.",
  inputSchema: z.object({ enabled: z.boolean() }),
  run: ({ enabled }, ctx) => {
    ctx.updateState?.(patchState({ streamingEnabled: enabled }));
  },
});

export const incrementTestCounter = createAction({
  state: agentControlsState,
  name: "incrementTestCounter",
  description: "Increment the agent controls test counter.",
  inputSchema: z.object({ amount: z.number().default(1) }),
  run: async ({ amount }, ctx) => {
    await delay(3000);
    ctx.updateState?.((current) => {
      const state = agentControlsStateSchema.parse(current);
      return patchState({ testCounter: state.testCounter + amount });
    });
  },
});

export const setThemeHue = createAction({
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
  description: "Respond with pong.",
  inputSchema: z.object({}),
  run: () => pongAssistantMessage(),
});

export const pingCommand = createAction({
  state: null,
  name: "ping",
  description: "Respond with pong.",
  inputSchema: z.object({}),
  run: (): unknown => {
    const message = pongAssistantMessage();
    return actionResult({ value: message, messages: [message] });
  },
});

export const echoSessionIdTool = createAction({
  state: null,
  params: demoParamsSchema,
  name: "echoSessionId",
  description: "Echo the current demo session id.",
  inputSchema: z.object({}),
  run: (_input, ctx) => sessionIdAssistantMessage(ctx.params.sessionId),
});

export const echoSessionIdCommand = createAction({
  state: null,
  params: demoParamsSchema,
  name: "echoSessionId",
  description: "Echo the current demo session id.",
  inputSchema: z.object({}),
  run: (_input, ctx): unknown => {
    const message = sessionIdAssistantMessage(ctx.params.sessionId);
    return actionResult({ value: message, messages: [message] });
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
    // History rendering is layout-owned with no per-node override, so this
    // single policy dispatches: only the memory generator (the charter's one
    // parent-completion trigger) sees the extraction prompt; every other
    // generator keeps plain message history.
    if (ctx.trigger.type !== "parent-completion") {
      return messages(ctx);
    }
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

// The demo layout mirrors the implicit default layout; it exists to carry the
// memory history projection, which is layout-owned in the parts model.
const demoLayout = createLayout({
  name: "demo",
  default: true,
  historyProjection: memoryHistoryProjection,
  regions: {
    preamble: [createSlot("body", { default: true })],
    recency: [createSlot("context", { default: true, volatile: true })],
  },
});

export const memoryMemberNode = createNode({
  key: "memory",
  name: "MemoryNode",
  instructions:
    "Maintain durable user memories. Save only concise, stable, generally useful user facts. Do not create a memory for every message.",
  states: [memoriesState],
  tools: [saveMemories],
  // boundaryProjection defaults to "hidden": the memory generator is a
  // private sub-machine and nothing crosses into the parent document (the
  // replacement for the removed replaceProjection).
  runtime: {
    type: "generator",
    trigger: { type: "parent-completion" },
    concurrency: "serial",
    activationHistory: "snapshot",
    outputAudienceDefault: "self",
  },
});

export const agentControlsMemberNode = createNode({
  key: "agentControls",
  name: "Agent Controls",
  // The old projection hid this node's dev-facing instructions from the
  // model ("Expose client commands for voice, camera, streaming, memory, and
  // test controls."), so it contributes no prose — just state and actions.
  states: [agentControlsState],
  tools: [enableLiveMode, enableCamera],
  commands: [
    setVoiceEnabled,
    setCameraEnabled,
    setMemoryEnabled,
    setStreamingEnabled,
    incrementTestCounter,
  ],
});

export const demoBaseNode = createNode({
  key: "demoBase",
  name: "Projector Demo Agent",
  params: demoParamsSchema,
  instructions:
    "You are a friendly conversation buddy. Be natural, concise, and curious. Do not volunteer internal state, tools, framework details, or state changes during ordinary conversation. If the user asks about your internals, capabilities, memory, tools, state, or how you work, answer directly and transparently with the information available to you.",
  states: [demoState],
  tools: [pingTool, echoSessionIdTool],
  commands: [pingCommand, echoSessionIdCommand, setThemeHue],
  members: [agentControlsMemberNode],
});

export function createDemoCharter(
  options: { cameraSensor?: CameraSensorDataSource } = {},
): Charter<any, DemoParamsSchema> {
  if ("cameraSensor" in options) {
    cameraSensorDataSource = options.cameraSensor;
  }
  return createCharter({
    key: "projector-demo",
    version: "1",
    params: demoParamsSchema,
    nodes: [
      demoBaseNode,
      memoryMemberNode,
      agentControlsMemberNode,
      cameraSensorNode,
    ],
    tools: [pingTool, echoSessionIdTool, saveMemories, enableLiveMode, enableCamera],
    commands: [
      pingCommand,
      echoSessionIdCommand,
      setVoiceEnabled,
      setCameraEnabled,
      setMemoryEnabled,
      setStreamingEnabled,
      incrementTestCounter,
      setThemeHue,
    ],
    states: [demoState, memoriesState, agentControlsState],
    layouts: [demoLayout],
    computedParts: [cameraSnapshotPart],
    historyProjections: [memoryHistoryProjection],
  });
}

export function createInitialDemoSourceInstance(): Instance<any> {
  const demoBase = createSourceInstance({
    id: `demo-${crypto.randomUUID()}`,
    node: demoBaseNode,
  });
  resolveStates(demoBase);
  return demoBase;
}

export function createDemoMachineRoot(
  source: Instance<any>,
  params: z.input<typeof demoParamsSchema>,
): Instance<any> {
  reconcileAgentControlMembers(source);
  const root = createRoot(createDemoCharter(), [source], params);
  resolveStates(root);
  return root;
}

export function createInitialDemoMachineRoot(
  sessionId = `session-${crypto.randomUUID()}`,
): Instance<any> {
  return createDemoMachineRoot(createInitialDemoSourceInstance(), { sessionId });
}

export function createInitialDemoInstance(
  sessionId = `session-${crypto.randomUUID()}`,
): Instance<any> {
  return createInitialDemoMachineRoot(sessionId);
}

export function createInitialSerializedInstance(): SerializedInstance<any> {
  return serializeDemoSourceInstance(createInitialDemoSourceInstance());
}

export function hydrateDemoSourceInstance(serialized: SerializedInstance<any>): Instance<any> {
  const instance = hydrateInstance(serialized, createDemoCharter());
  resolveStates(instance);
  return instance;
}

export function serializeDemoSourceInstance(instance: Instance<any>): SerializedInstance<any> {
  resolveStates(instance);
  return serializeInstance(instance, createDemoCharter());
}

export function hydrateDemoInstance(
  serialized: SerializedInstance<any>,
  sessionId: string,
): Instance<any> {
  return createDemoMachineRoot(hydrateDemoSourceInstance(serialized), {
    sessionId,
  });
}

export function serializeDemoInstance(instance: Instance<any>): SerializedInstance<any> {
  const source = findDemoSourceInstance(instance);
  if (!source) {
    throw new Error("Demo instance tree has no source instance");
  }
  return serializeDemoSourceInstance(source);
}

export function getDemoRootGenerator(_instance: Instance<any>): GeneratorId {
  return ROOT_GENERATOR_ID;
}

export function createDemoClientSnapshot(
  serialized: SerializedInstance<any>,
  sessionId: string,
  syncState: MachineSyncState = { recentCommandResidue: [] },
): DemoClientSnapshot {
  const instance = hydrateDemoInstance(serialized, sessionId);
  return {
    ...createMachineClientSnapshot(realizeClientInstances(instance as Instance), syncState),
    projectionTree: inspectCompiledProjectionTree(instance, {
      charter: createDemoCharter(),
    }),
  };
}

function findDemoSourceInstance(instance: Instance<any>): Instance<any> | undefined {
  if (instance.isSource) {
    return instance;
  }
  for (const child of instance.children ?? []) {
    const source = findDemoSourceInstance(child);
    if (source) {
      return source;
    }
  }
  return undefined;
}

function reconcileAgentControlMembers(instance: Instance<any>): void {
  const controls = agentControlsStateSchema.safeParse(
    readResolvedState(instance, "agentControls"),
  );
  if (!controls.success) return;

  reconcileOptionalMember(instance, cameraSensorNode, controls.data.cameraEnabled);
  reconcileOptionalMember(instance, memoryMemberNode, controls.data.memoryEnabled);
  resolveStates(instance);
}

function reconcileOptionalMember(
  instance: Instance<any>,
  node: typeof cameraSensorNode | typeof memoryMemberNode,
  enabled: boolean,
): void {
  const existingChildren = instance.children ?? [];
  const matchingChild = existingChildren.find((child) => child.node.key === node.key);
  const children = existingChildren.filter((child) => child.node.key !== node.key);
  if (enabled) {
    children.push(matchingChild ?? { id: `${node.key}-${crypto.randomUUID()}`, node });
  }
  instance.children = children.length > 0 ? children : undefined;
}

export function getDemoState(instance: Instance<any>): DemoState {
  return demoStateSchema.parse(readResolvedState(instance, "demo"));
}

export function setDemoState(instance: Instance<any>, next: DemoState): void {
  demoStateSchema.parse(next);
  writeResolvedState(instance, "demo", next);
}

export function getAgentControlsState(instance: Instance<any>): AgentControlsState {
  return agentControlsStateSchema.parse(
    readResolvedState(instance, "agentControls"),
  );
}

export function setAgentControlsState(
  instance: Instance<any>,
  next: AgentControlsState,
): void {
  agentControlsStateSchema.parse(next);
  writeResolvedState(instance, "agentControls", next);
}

export function getMemoriesState(instance: Instance<any>): MemoriesState {
  return memoriesStateSchema.parse(readResolvedState(instance, "memories"));
}

export function setMemoriesState(
  instance: Instance<any>,
  next: MemoriesState,
): void {
  memoriesStateSchema.parse(next);
  writeResolvedState(instance, "memories", next);
}

function readResolvedState(instance: Instance<any>, key: string): unknown {
  const state = resolveStates(instance).find(
    (candidate) => candidate.address.stateKey === key,
  );
  if (!state) {
    throw new Error(`Unknown demo state "${key}"`);
  }
  return state.container.value;
}

function writeResolvedState(
  instance: Instance<any>,
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

function pongAssistantMessage() {
  return textAssistantMessage("pong");
}

function sessionIdAssistantMessage(sessionId: string) {
  return textAssistantMessage(sessionId);
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
  messages: Array<Record<string, unknown> & {
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
      if (message.type === "action")
        return `Action ${message.action ?? "unknown"} ${message.kind ?? "message"} ${message.name ?? "unknown"}: ${stringifyValue(message.value ?? message.error ?? message.input)}`;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
