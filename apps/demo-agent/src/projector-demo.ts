import { z } from "zod";
import {
  createAction,
  createCharter,
  createCommand,
  createNode,
  encodeRuntimeAddress,
  hydrateInstance,
  inspectCompiledProjectionTree,
  messagesBeforeLastCompletion,
  messagesSinceLastCompletion,
  resolveStates,
  serializeInstance,
  type CompiledProjectionTree,
  type Charter,
  type Executor,
  type Generator,
  type HistoryProjectionFunction,
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
  frameId?: string;
  mode?: "text" | "voice";
  streamState?: "streaming" | "complete" | "error";
  streamSeq?: number;
};

export type DemoClientSnapshot = MachineClientSnapshot & {
  projectionTree: CompiledProjectionTree;
};

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
    ctx.patchState?.({ liveMode: enabled });
  },
});

export const setCameraEnabled = createCommand({
  state: agentControlsState,
  name: "setCameraEnabled",
  description: "Toggle camera sampling in live mode.",
  inputSchema: z.object({ enabled: z.boolean() }),
  run: ({ enabled }, ctx) => {
    ctx.patchState?.({ cameraEnabled: enabled });
  },
});

export const setStreamingEnabled = createCommand({
  state: agentControlsState,
  name: "setStreamingEnabled",
  description: "Toggle streaming-style assistant output.",
  inputSchema: z.object({ enabled: z.boolean() }),
  run: ({ enabled }, ctx) => {
    ctx.patchState?.({ streamingEnabled: enabled });
  },
});

export const incrementTestCounter = createCommand({
  state: agentControlsState,
  name: "incrementTestCounter",
  description: "Increment the agent controls test counter.",
  inputSchema: z.object({ amount: z.number().default(1) }),
  run: ({ amount }, ctx) => {
    const state = agentControlsStateSchema.parse(ctx.state);
    ctx.patchState?.({ testCounter: state.testCounter + amount });
  },
});

export const setThemeHue = createCommand({
  state: demoState,
  name: "setThemeHue",
  description: "Change the terminal accent hue.",
  inputSchema: z.object({ hue: z.number().min(0).max(360) }),
  run: ({ hue }, ctx) => {
    ctx.patchState?.({ themeHue: hue });
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
  description: "Update durable demo state when the user shares a name or favorite.",
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

    ctx.replaceState?.(next);
    return "Demo state updated.";
  },
});

export const saveMemories = createAction({
  state: memoriesState,
  name: "saveMemories",
  description: "Save durable user memories extracted from recent conversation messages.",
  inputSchema: z.object({
    memories: z.array(memorySchema).max(10),
  }),
  run: ({ memories }, ctx) => {
    const existing = memoriesStateSchema.parse(ctx.state);
    const merged = mergeMemories(existing, memories);
    ctx.replaceState?.(merged);
    return memories.length === 0
      ? "No new memories saved."
      : `Saved ${memories.length} memories.`;
  },
});

export const memoryHistoryProjection: HistoryProjectionFunction = (ctx) => {
  const previousMessages = messagesBeforeLastCompletion(ctx);
  const newMessages = messagesSinceLastCompletion(ctx);
  const memories = memoriesStateSchema.safeParse(ctx.states.memories).success
    ? (ctx.states.memories as MemoriesState)
    : [];

  return [
    {
      type: "user",
      text: [
        "Below is a conversation log between a user and an agent.",
        "Analyze the new messages and call saveMemories with any durable new memories.",
        "",
        "Rules:",
        "- Save stable user facts, preferences, names, and recurring context.",
        "- Ignore one-off tasks, temporary details, and assistant claims.",
        "- Do not duplicate current memories.",
        "- If there are no new durable memories, call saveMemories with an empty memories array.",
        "",
        "Current memories:",
        renderMemories(memories),
        "",
        "Conversation history before the last memory update:",
        renderActorMessages(previousMessages),
        "",
        "New messages since the last memory update:",
        renderActorMessages(newMessages),
      ].join("\n"),
    },
  ];
};

export const memoryMemberNode = createNode({
  key: "memory",
  name: "MemoryNode",
  instructions:
    "Maintain durable user memories. Keep memories concise, stable, and useful for future replies.",
  state: memoriesState,
  tools: [saveMemories],
  projection: { mode: "replace", instructions: "dynamic" },
  runtime: {
    type: "worker",
    trigger: { type: "parent-completion" },
    concurrency: "serial",
    activationHistory: "snapshot",
    historyProjection: "memory",
    boundaryProjection: { mode: "augment", instructions: "dynamic", tools: "hidden" },
  },
});

export const agentControlsMemberNode = createNode({
  key: "agentControls",
  name: "Agent Controls",
  instructions: "Expose client commands for voice, camera, streaming, and theme controls.",
  state: agentControlsState,
  commands: [setVoiceEnabled, setCameraEnabled, setStreamingEnabled, incrementTestCounter],
  projection: { instructions: "hidden", tools: "hidden" },
});

export const rootNode = createNode({
  key: "demoRoot",
  name: "Projector Demo Agent",
  instructions:
    "You are a compact demo assistant. Be direct, remember small facts, and explain what changed in state. Call updateDemoState when the user shares their name or a favorite.",
  state: demoState,
  tools: [pingTool, updateDemoState],
  commands: [setThemeHue],
  members: [memoryMemberNode, agentControlsMemberNode],
  runtime: {
    type: "primary",
    trigger: { type: "actor-frame" },
    boundaryProjection: { mode: "augment", instructions: "system", tools: "provider-static" },
  },
});

const executor: Executor = {
  run: async () => ({ completionReason: "done" }),
};

export function createDemoCharter(options: { executor?: Executor } = {}): Charter {
  return createCharter({
    key: "projector-demo",
    version: "1",
    executor: options.executor ?? executor,
    nodes: {
      demoRoot: rootNode,
      memory: memoryMemberNode,
      agentControls: agentControlsMemberNode,
    },
    tools: {
      ping: pingTool,
      updateDemoState,
      saveMemories,
    },
    commands: {
      setVoiceEnabled,
      setCameraEnabled,
      setStreamingEnabled,
      incrementTestCounter,
      setThemeHue,
    },
    states: {
      demo: rootNode.state!,
      memories: memoryMemberNode.state!,
      agentControls: agentControlsMemberNode.state!,
    },
    projections: {},
    historyProjections: {
      memory: memoryHistoryProjection,
    },
  });
}

export function createInitialDemoInstance(): Instance {
  const instance: Instance = {
    id: `demo-${crypto.randomUUID()}`,
    node: rootNode,
  };
  resolveStates(instance);
  return instance;
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

export function getDemoRootGenerator(instance: Instance): Generator {
  const runtimeInstanceId = encodeRuntimeAddress({ type: "instance", instanceId: instance.id });
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
    projectionTree: inspectCompiledProjectionTree(instance, { charter: createDemoCharter() }),
  };
}

export function getDemoState(instance: Instance): DemoState {
  resolveStates(instance);
  const value = instance.states?.demo?.value;
  return demoStateSchema.parse(value);
}

export function setDemoState(instance: Instance, next: DemoState): void {
  demoStateSchema.parse(next);
  instance.states ??= {};
  instance.states.demo = { value: next };
}

export function getAgentControlsState(instance: Instance): AgentControlsState {
  resolveStates(instance);
  const value = instance.states?.agentControls?.value;
  return agentControlsStateSchema.parse(value);
}

export function setAgentControlsState(instance: Instance, next: AgentControlsState): void {
  agentControlsStateSchema.parse(next);
  instance.states ??= {};
  instance.states.agentControls = { value: next };
}

export function getMemoriesState(instance: Instance): MemoriesState {
  resolveStates(instance);
  const value = instance.states?.memories?.value;
  return memoriesStateSchema.parse(value);
}

export function setMemoriesState(instance: Instance, next: MemoriesState): void {
  memoriesStateSchema.parse(next);
  instance.states ??= {};
  instance.states.memories = { value: next };
}

function mergeMemories(existing: MemoriesState, next: MemoriesState): MemoriesState {
  const seen = new Set(existing.map((memory) => normalizeMemoryText(memory.text)));
  const merged = [...existing];
  for (const memory of next) {
    const text = memory.text.trim();
    const normalized = normalizeMemoryText(text);
    if (!text || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push({ text });
  }
  return merged;
}

function normalizeMemoryText(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/[.!?]+$/g, "").toLowerCase();
}

function renderMemories(memories: MemoriesState): string {
  if (memories.length === 0) {
    return "(none)";
  }
  return memories.map((memory, index) => `${index + 1}. ${memory.text}`).join("\n");
}

function renderActorMessages(messages: Array<{ type: string; text?: string; name?: string; value?: unknown }>): string {
  if (messages.length === 0) {
    return "(none)";
  }
  return messages.map((message) => {
    if (message.type === "user") return `User: ${message.text ?? ""}`;
    if (message.type === "assistant") return `Assistant: ${message.text ?? ""}`;
    if (message.type === "tool") return `Tool ${message.name ?? "unknown"}: ${message.text ?? stringifyValue(message.value)}`;
    return `${message.type}: ${stringifyValue(message)}`;
  }).join("\n");
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
