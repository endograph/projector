import type {
  Machine,
  MachineStep,
  Message,
  Instance,
  Charter,
  LeafResult,
  ActiveLeafInfo,
  YieldReason,
} from "markov-machines";
import {
  getActiveLeaves,
  mergeLeafResults,
  userMessage,
  buildDefaultSystemPrompt,
  generateToolDefinitions,
} from "markov-machines";

import type {
  VoiceRuntimeConfig,
  VoiceMachineRunner,
  VoiceEvent,
  VoiceRunOptions,
  LiveKitOptions,
  VoiceTurnResult,
  RealtimeToolDefinition,
} from "./types.js";
import { LiveKitAdapter } from "./livekit-adapter.js";
import { RealtimeClient } from "./realtime-client.js";

type EventHandler<E extends VoiceEvent["type"]> = (
  event: Extract<VoiceEvent, { type: E }>,
) => void;

/**
 * Create a voice machine runner.
 * This is the main factory function for voice support.
 */
export function createVoiceMachineRunner<AppMessage = unknown>(
  config: VoiceRuntimeConfig,
): VoiceMachineRunner<AppMessage> {
  return new LiveKitVoiceRuntime<AppMessage>(config);
}

/**
 * LiveKit Voice Runtime implementation.
 * Yields MachineStep like runMachine, but uses OpenAI Realtime for the primary node
 * and StandardExecutor for workers.
 */
class LiveKitVoiceRuntime<AppMessage = unknown>
  implements VoiceMachineRunner<AppMessage>
{
  private config: VoiceRuntimeConfig;
  private _isConnected = false;
  private transcriptHistory: Message<AppMessage>[] = [];
  private eventHandlers: Map<VoiceEvent["type"], Set<EventHandler<any>>> =
    new Map();

  // These will be set during run()
  private machine: Machine<AppMessage> | null = null;
  private stopRequested = false;

  // LiveKit and Realtime components
  private liveKitAdapter: LiveKitAdapter;
  private realtimeClient: RealtimeClient;

  // Current instance - accessed by tool executor to avoid stale closures
  private currentInstance: Instance | null = null;

  constructor(config: VoiceRuntimeConfig) {
    this.config = config;
    this.liveKitAdapter = new LiveKitAdapter({ debug: config.debug });
    this.realtimeClient = new RealtimeClient(config);

    // Wire up realtime events to our event handlers
    this.realtimeClient.setEventCallback((event) => this.emit(event));
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Main entry point - yields MachineStep like runMachine does.
   */
  async *run(
    machine: Machine<AppMessage>,
    livekit: LiveKitOptions,
    options?: VoiceRunOptions<AppMessage>,
  ): AsyncGenerator<MachineStep<AppMessage>> {
    this.machine = machine;
    this.transcriptHistory = [...(machine.history ?? [])];
    this.stopRequested = false;

    try {
      // 1. Connect to LiveKit room
      await this.connectLiveKit(livekit);

      // 2. Set up tool executor to bridge to markov-machines tools
      // Note: Uses this.currentInstance to avoid stale closure issues
      this.currentInstance = machine.instance;
      this.realtimeClient.setToolExecutor(async (name, argsJson) => {
        if (!this.currentInstance) {
          return "Error: No active instance";
        }
        return this.executeToolCall(machine.charter, this.currentInstance, name, argsJson);
      });

      this._isConnected = true;
      // Note: session_started event is emitted by RealtimeClient.startSession()

      // Configure session for the primary (non-worker) node
      await this.configureSessionForPrimaryNode(
        machine.charter,
        this.currentInstance,
      );

      // 3. Main loop - each iteration is one "voice turn"
      while (this._isConnected && !this.stopRequested) {
        // Wait for voice turn to complete (user speech → assistant response)
        const voiceTurn = await this.waitForVoiceTurnComplete();

        // Update transcript history
        if (voiceTurn.userTranscript) {
          this.transcriptHistory.push(
            userMessage<AppMessage>(voiceTurn.userTranscript),
          );
        }
        this.transcriptHistory.push(...voiceTurn.messages);
        options?.onTranscriptUpdate?.(this.transcriptHistory);

        // 4. Run ALL active leaves - workers via StandardExecutor
        const leaves = getActiveLeaves(this.currentInstance);
        const workerLeaves = leaves.filter((l) => l.isWorker);
        const primaryLeaf = leaves.find((l) => !l.isWorker);

        // Run workers in parallel via StandardExecutor (they get empty input)
        const workerResults = await Promise.all(
          workerLeaves.map((leaf) =>
            this.runWorkerLeaf(leaf, machine.charter, this.transcriptHistory),
          ),
        );

        // Merge primary voice result + worker results into MachineStep
        const step = this.mergeIntoMachineStep(
          this.currentInstance,
          voiceTurn,
          workerResults,
          primaryLeaf,
        );

        yield step;

        if (step.done) break;

        // Update current instance for next iteration and tool executor
        this.currentInstance = step.instance;

        // Reconfigure voice session if primary node changed (transition occurred)
        if (voiceTurn.transitioned) {
          await this.configureSessionForPrimaryNode(
            machine.charter,
            this.currentInstance,
          );
        }
      }
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Stop the voice session and disconnect.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.cleanup();
  }

  /**
   * Subscribe to real-time events.
   */
  on<E extends VoiceEvent["type"]>(
    event: E,
    handler: EventHandler<E>,
  ): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.eventHandlers.get(event)?.delete(handler);
    };
  }

  /**
   * Get the accumulated transcript history.
   */
  getTranscriptHistory(): Message<AppMessage>[] {
    return [...this.transcriptHistory];
  }

  // ============================================================================
  // Private: LiveKit Connection
  // ============================================================================

  private async connectLiveKit(livekit: LiveKitOptions): Promise<void> {
    if (this.config.debug) {
      console.log("[VoiceRuntime] Connecting to LiveKit room...");
    }
    const room = await this.liveKitAdapter.connect(livekit);
    await this.realtimeClient.initialize(room);
  }

  private async cleanup(): Promise<void> {
    this.currentInstance = null;
    this._isConnected = false;
    if (this.config.debug) {
      console.log("[VoiceRuntime] Cleaning up...");
    }
    await this.realtimeClient.close();
    await this.liveKitAdapter.disconnect();
  }

  // ============================================================================
  // Private: Session Configuration
  // ============================================================================

  private async configureSessionForPrimaryNode(
    charter: Charter<AppMessage>,
    root: Instance,
  ): Promise<void> {
    const primary = getActiveLeaves(root).find((l) => !l.isWorker);
    if (!primary) return;

    const instance = primary.path[primary.path.length - 1]!;
    const ancestors = primary.path.slice(0, -1);

    // Build voice-optimized system prompt
    const prompt = this.buildVoiceSystemPrompt(
      instance,
      root.packStates ?? {},
    );

    // Convert tools to OpenAI Realtime format
    const anthropicTools = generateToolDefinitions(
      charter,
      instance.node,
      ancestors.map((a) => a.node),
    );
    const tools = this.convertToolsToOpenAIFormat(anthropicTools);

    // Start or update the realtime session
    if (!this.realtimeClient.isConnected) {
      await this.realtimeClient.startSession(prompt, tools);
    } else {
      await this.realtimeClient.updateInstructions(prompt);
      await this.realtimeClient.updateTools(tools);
    }

    if (this.config.debug) {
      console.log("[VoiceRuntime] Configured session for node:", {
        instructions: prompt.slice(0, 100) + "...",
        toolCount: tools.length,
      });
    }
  }

  private buildVoiceSystemPrompt(
    instance: Instance,
    packStates: Record<string, unknown>,
  ): string {
    const basePrompt = buildDefaultSystemPrompt(
      instance.node,
      instance.state,
      [], // Simplified ancestors for voice
      packStates,
    );

    // Add voice-specific instructions
    const voiceAddendum = `

## Voice Interaction Guidelines
- Respond conversationally and concisely
- Use natural speech patterns
- Confirm actions before executing irreversible operations
- If interrupted, acknowledge and adapt
- Keep responses under 30 seconds of speech when possible`;

    return basePrompt + voiceAddendum;
  }

  private convertToolsToOpenAIFormat(
    anthropicTools: { name: string; description?: string; input_schema: unknown }[],
  ): RealtimeToolDefinition[] {
    return anthropicTools.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.input_schema as Record<string, unknown>,
    }));
  }

  // ============================================================================
  // Private: Voice Turn Handling
  // ============================================================================

  private async waitForVoiceTurnComplete(): Promise<VoiceTurnResult<AppMessage>> {
    // Wait for the realtime client to complete a turn
    const turnResult = await this.realtimeClient.waitForTurn();

    // Note: Events (speech_ended, response_ended) are already emitted by RealtimeClient
    // Don't duplicate them here

    // Build messages from the turn
    const messages: Message<AppMessage>[] = [];
    if (turnResult.assistantTranscript) {
      messages.push({
        role: "assistant",
        content: turnResult.assistantTranscript,
      });
    }

    // Check if any function calls were transitions
    // Transition tools are named like "transition_to_<nodeName>"
    const transitioned = turnResult.functionCalls.some(
      (fc) => fc.name.startsWith("transition_to_")
    );

    // Use this.currentInstance which has been updated by tool execution
    const instance = this.currentInstance!;

    return {
      instanceId: instance.id,
      userTranscript: turnResult.userTranscript,
      messages,
      updatedInstance: instance,
      yieldReason: "end_turn" as YieldReason,
      packStates: instance.packStates,
      transitioned,
      wasInterrupted: turnResult.wasInterrupted,
    };
  }

  // ============================================================================
  // Private: Worker Execution
  // ============================================================================

  /**
   * Run a worker leaf via StandardExecutor - same as text mode.
   */
  private async runWorkerLeaf(
    leaf: ActiveLeafInfo,
    charter: Charter<AppMessage>,
    history: Message<AppMessage>[],
  ): Promise<LeafResult<AppMessage>> {
    const instance = leaf.path[leaf.path.length - 1]!;
    const ancestors = leaf.path.slice(0, -1);

    // Workers get empty input (same as text mode!)
    const result = await charter.executor.run(
      charter,
      instance,
      ancestors,
      "", // Empty input for workers
      { history },
    );

    return {
      leafIndex: leaf.leafIndex,
      isWorker: true,
      instanceId: instance.id,
      ...result,
    };
  }

  // ============================================================================
  // Private: Result Merging
  // ============================================================================

  /**
   * Merge voice turn result + worker results using same logic as runMachine.
   */
  private mergeIntoMachineStep(
    root: Instance,
    voiceTurn: VoiceTurnResult<AppMessage>,
    workerResults: LeafResult<AppMessage>[],
    primaryLeaf: ActiveLeafInfo | undefined,
  ): MachineStep<AppMessage> {
    // Convert voice turn to LeafResult format
    const primaryResult: LeafResult<AppMessage> = {
      leafIndex: primaryLeaf?.leafIndex ?? [],
      isWorker: false,
      instanceId: voiceTurn.instanceId,
      instance: voiceTurn.updatedInstance,
      messages: voiceTurn.messages,
      yieldReason: voiceTurn.yieldReason,
      packStates: voiceTurn.packStates,
      cedeContent: voiceTurn.cedeContent,
    };

    // Use existing mergeLeafResults logic!
    const allResults = [primaryResult, ...workerResults];
    const merged = mergeLeafResults<AppMessage>(root, allResults);

    // In voice mode, done is only true if the primary node ceded or all leaves terminated
    // "end_turn" means the turn completed normally, not that the conversation is done
    const done = merged.yieldReason === "cede" ||
                 merged.yieldReason === "suspend" ||
                 !merged.instance;

    return {
      instance: merged.instance,
      messages: merged.messages,
      yieldReason: merged.yieldReason,
      done,
      cedeContent: merged.cedeContents[0]?.content,
    };
  }

  // ============================================================================
  // Private: Tool Execution Bridge
  // ============================================================================

  /**
   * Execute a tool call from the voice model.
   * This bridges to the markov-machines tool system.
   */
  private async executeToolCall(
    charter: Charter<AppMessage>,
    instance: Instance,
    toolName: string,
    argsJson: string,
  ): Promise<string> {
    try {
      const args = JSON.parse(argsJson);

      // Check for updateState built-in tool
      if (toolName === "updateState") {
        return this.handleUpdateStateTool(instance, args);
      }

      // Resolve the tool from node -> ancestors -> charter -> packs
      const tool = instance.node.tools[toolName] ?? charter.tools[toolName];

      if (!tool) {
        return `Unknown tool: ${toolName}`;
      }

      // Skip builtin tools like computer_use, etc.
      if ("type" in tool) {
        return `Builtin tool ${toolName} not supported in voice mode`;
      }

      // Validate input
      const inputResult = tool.inputSchema.safeParse(args);
      if (!inputResult.success) {
        return `Invalid tool input: ${inputResult.error.message}`;
      }

      // Create context for tool execution
      let currentState = instance.state;
      let stateChanged = false;
      const ctx = {
        state: currentState,
        updateState: (patch: Partial<unknown>) => {
          currentState = { ...currentState, ...patch };
          stateChanged = true;
        },
        instanceId: instance.id,
        getInstanceMessages: () => {
          return this.transcriptHistory.filter(
            (msg) => msg.metadata?.sourceInstanceId === instance.id
          );
        },
      };

      // Execute the tool
      const output = await tool.execute(inputResult.data, ctx);

      // Apply state updates to the instance if any occurred
      if (stateChanged && this.currentInstance) {
        this.applyStateUpdate(instance.id, currentState);
      }

      // Convert output to string
      if (typeof output === "string") {
        return output;
      }
      return JSON.stringify(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Tool execution error: ${message}`;
    }
  }

  /**
   * Handle the built-in updateState tool.
   */
  private handleUpdateStateTool(
    instance: Instance,
    args: { patch: Record<string, unknown> },
  ): string {
    if (!args.patch || typeof args.patch !== "object") {
      return "Error: updateState requires a 'patch' object";
    }

    const newState = { ...instance.state, ...args.patch };

    // Validate against the node's schema if available
    if (instance.node.validator) {
      const result = instance.node.validator.safeParse(newState);
      if (!result.success) {
        return `State validation failed: ${result.error.message}`;
      }
    }

    this.applyStateUpdate(instance.id, newState);
    return "State updated successfully";
  }

  /**
   * Apply a state update to the current instance tree.
   * Updates the instance in place and emits a state_updated event.
   */
  private applyStateUpdate(instanceId: string, newState: unknown): void {
    if (!this.currentInstance) return;

    // Update the instance state in the tree
    // For now, we only handle the root instance case
    // TODO: Handle nested instances (workers, spawned children)
    if (this.currentInstance.id === instanceId) {
      this.currentInstance = {
        ...this.currentInstance,
        state: newState,
      };

      this.emit({
        type: "state_updated",
        instanceId,
        state: newState,
      });

      if (this.config.debug) {
        console.log("[VoiceRuntime] State updated for instance:", instanceId);
      }
    }
  }

  // ============================================================================
  // Private: Event Emission
  // ============================================================================

  private emit<E extends VoiceEvent>(event: E): void {
    const handlers = this.eventHandlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (error) {
          console.error(
            `[VoiceRuntime] Error in event handler for ${event.type}:`,
            error,
          );
        }
      }
    }
  }
}
