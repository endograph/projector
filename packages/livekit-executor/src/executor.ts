/**
 * LiveKitExecutor - An executor that delegates inference to a LiveKit voice agent.
 *
 * For primary nodes:
 * - Skips inference (no LLM call)
 * - Pushes instructions and tools to the LiveKit agent
 * - Returns yieldReason: "external" so runMachine waits for queue
 *
 * For worker nodes:
 * - Delegates to StandardExecutor
 *
 * LiveKit events are mapped to machine messages via machine.enqueue().
 */

import { llm, voice } from "@livekit/agents";
import {
  type Executor,
  type RunOptions,
  type RunResult,
  type Charter,
  type Instance,
  type Machine,
  type MachineMessage,
  type ToolCall,
  type InstanceMessage,
  StandardExecutor,
  buildSystemPrompt,
  generateToolDefinitions,
  runToolPipeline,
  userMessage,
  assistantMessage,
  findInstanceById,
  createStandardExecutor,
  createInstance,
  getActiveInstance,
  getInstancePath,
  getMessageText,
  isInstanceMessage,
} from "markov-machines";

import type { LiveKitExecutorConfig, ConnectConfig, LiveKitToolDefinition } from "./types.js";

// Counter for generating unique tool call IDs
let toolCallIdCounter = 0;
function generateToolCallId(): string {
  return `tc_${Date.now()}_${++toolCallIdCounter}`;
}

/**
 * LiveKitExecutor delegates voice inference to a LiveKit agent.
 *
 * Usage:
 * ```ts
 * const executor = new LiveKitExecutor();
 * const charter = createCharter({ executor, ... });
 * const machine = createMachine(charter, ...);
 *
 * // In your LiveKit agent entry:
 * await executor.connect(machine, { session, room: ctx.room });
 *
 * // Run the machine loop
 * for await (const step of runMachine(machine)) {
 *   await saveToConvex(step);
 * }
 * ```
 */
export class LiveKitExecutor implements Executor {
  type = "livekit";

  private config: LiveKitExecutorConfig;
  private workerExecutor: StandardExecutor;
  private machine: Machine | null = null;
  private session: voice.AgentSession | null = null;
  private agent: voice.Agent | null = null;
  private connected = false;

  /** Track whether we've bootstrapped history into LiveKit for this live session */
  private hasBootstrappedHistory = false;
  /** Track the last history length we bootstrapped from, to avoid re-bootstrapping unchanged history */
  private lastBootstrappedHistoryLength = 0;

  constructor(config: LiveKitExecutorConfig = {}) {
    this.config = config;
    this.workerExecutor = createStandardExecutor({
      debug: config.debug,
      apiKey: config.apiKey,
      model: config.model,
      maxTokens: config.maxTokens,
    });
  }

  /**
   * Set whether we're in live (voice) mode.
   * When true, primary nodes delegate to LiveKit.
   * When false, primary nodes use StandardExecutor.
   */
  setLive(isLive: boolean): void {
    const wasLive = this.config.isLive ?? false;
    this.config.isLive = isLive;
    this.log(`Live mode: ${isLive}`);

    if (this.machine) {
      const active = getActiveInstance(this.machine.instance);
      const currentToolNames = this.agent?._tools ? Object.keys(this.agent._tools) : [];
      console.log(`[LiveKit setLive(${isLive})] Current active node: ${active.node.id} (${active.node.name ?? "unnamed"}), tools: [${currentToolNames.join(", ")}]`);
    }

    // Reset bootstrap tracking when transitioning out of live mode
    // This ensures we re-bootstrap history next time live mode is enabled
    if (wasLive && !isLive) {
      this.hasBootstrappedHistory = false;
      this.lastBootstrappedHistoryLength = 0;
      this.log("Reset history bootstrap tracking");
    }

    // If turning on live mode, push config immediately to bootstrap history
    if (!wasLive && isLive && this.connected) {
      this.pushConfigToLiveKit();
    }
  }

  /**
   * Get current live mode state.
   */
  get isLive(): boolean {
    return this.config.isLive ?? false;
  }

  /**
   * Connect the executor to a machine and LiveKit session.
   * Sets up event handlers that enqueue messages to the machine.
   */
  async connect(machine: Machine, connectConfig: ConnectConfig): Promise<void> {
    this.machine = machine;
    this.session = connectConfig.session;
    this.agent = connectConfig.agent;

    this.log("Connecting to LiveKit session...");

    // Set up event handlers
    this.setupEventHandlers();

    // Push initial config to LiveKit (instructions + tools)
    this.pushConfigToLiveKit();

    this.connected = true;
    this.log("Connected");
  }

  /**
   * Run the executor for a node instance.
   *
   * Worker nodes: always delegate to StandardExecutor
   * Primary nodes when isLive=true: skip inference, push config to LiveKit, return "external"
   * Primary nodes when isLive=false: delegate to StandardExecutor
   */
  async run(
    charter: Charter<any>,
    instance: Instance,
    ancestors: Instance[],
    input: string,
    options?: RunOptions,
  ): Promise<RunResult> {
    if (!this.connected) {
      throw new Error("LiveKitExecutor.connect() must be called before run()");
    }

    const isWorker = instance.node.worker === true;

    // Worker nodes always use StandardExecutor
    if (isWorker) {
      this.log(`Running worker node: ${instance.node.id}`);
      return this.workerExecutor.run(charter, instance, ancestors, input, options);
    }

    this.log(`Pushing primary node config to livekit. Instnace: ${instance.id}`)
    this.pushConfigToLiveKit();

    // Primary nodes: route based on isLive flag
    if (!this.config.isLive) {
      this.log(`Primary node run (text mode) - using StandardExecutor`);
      return this.workerExecutor.run(charter, instance, ancestors, input, options);
    } else {
      // Live mode: skip inference
      this.log(`Primary node run (live mode) - pushing config to LiveKit`);
      // Return "external" to signal waiting for LiveKit events
      return { yieldReason: "external" };
    }
  }

  /**
   * Set up LiveKit event handlers that enqueue messages to the machine.
   */
  private setupEventHandlers(): void {
    if (!this.session || !this.machine) return;

    const session = this.session;
    const machine = this.machine;

    // User speech transcription
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) {
        this.log(`User transcript: "${ev.transcript}"`);
        // Mark as external (from LiveKit STT)
        machine.enqueue([userMessage(ev.transcript, { source: { external: true } })]);
      }
    });

    // Assistant speech / conversation items
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      const currentActiveNode = getActiveInstance(machine.instance);
      const currentToolNames = this.agent?._tools ? Object.keys(this.agent._tools) : [];
      console.log(`[LiveKit Response] Current active node: ${currentActiveNode.node.id} (${currentActiveNode.node.name ?? "unnamed"}), tools: [${currentToolNames.join(", ")}]`);
      console.log(`[LiveKitExecutor] ConversationItemAdded: role=${item.role}, contentLength=${item.content?.length ?? 0}`);
      if (item.role === "assistant") {
        // Try textContent first (string parts), then fall back to audio transcript
        let content = item.textContent;
        if (!content && item.content) {
          // Check for audio content with transcript
          for (const part of item.content) {
            if (typeof part === "object" && "type" in part && part.type === "audio_content" && "transcript" in part) {
              content = part.transcript as string;
              break;
            }
          }
        }
        console.log(`[LiveKitExecutor] Assistant content: "${content?.slice(0, 100) ?? "(undefined)"}"`);
        if (content) {
          console.log(`[LiveKitExecutor] Enqueuing assistant message: "${content.slice(0, 50)}..."`);
          // Mark as external (from LiveKit TTS)
          machine.enqueue([assistantMessage(content, { source: { external: true } })]);
        }
      }
    });

    // Tool calls - handled via function_call events
    // Note: LiveKit tools are registered separately; here we intercept calls
    // The actual tool registration happens in pushConfigToLiveKit
  }

  /**
   * Render conversation history as a compact transcript for bootstrapping LiveKit context.
   * Filters out tool_use/tool_result blocks and keeps only conversational text.
   * 
   * @param history - Machine history to render
   * @param maxTurns - Maximum number of turns to include (default: 20)
   * @param maxChars - Maximum total characters (default: 4000)
   */
  private renderHistoryForBootstrap(
    history: MachineMessage[],
    maxTurns = 20,
    maxChars = 4000,
  ): string {
    const turns: string[] = [];
    let charCount = 0;

    // Process history in reverse to get most recent turns first
    for (let i = history.length - 1; i >= 0 && turns.length < maxTurns; i--) {
      const msg = history[i];
      if (!msg || msg.role === "system" || msg.role === "command") continue;

      const text = getMessageText(msg);
      if (!text) continue;

      const role = msg.role === "assistant" ? "Assistant" : "User";
      const turn = `${role}: ${text}`;

      if (charCount + turn.length > maxChars) break;

      turns.unshift(turn); // Add to front since we're processing in reverse
      charCount += turn.length;
    }

    if (turns.length === 0) return "";

    return `## Conversation so far\n\n${turns.join("\n\n")}`;
  }

  /**
   * Push current node's instructions and tools to the LiveKit agent.
   * Call this after instance mutations to ensure LiveKit has the correct config.
   */
  pushConfigToLiveKit(): void {
    if (!this.machine || !this.session || !this.agent) return;

    const charter = this.machine.charter;
    const rootInstance = this.machine.instance;
    // Get the active instance (leaf of the instance tree)
    const activeInstance = getActiveInstance(rootInstance);
    // Get the path from root to active, excluding the active instance itself
    const instancePath = getInstancePath(rootInstance);
    const ancestors = instancePath.slice(0, -1); // All except the last (active) instance
    // Pack states are stored on the root instance
    const packStates = rootInstance.packStates ?? {};

    // Build system prompt
    let instructions = buildSystemPrompt(
      charter,
      activeInstance.node,
      activeInstance.state,
      ancestors,
      packStates,
      {},
    );

    // Bootstrap history context when entering live mode
    // Only do this once per live session, or when history has grown significantly
    const currentHistoryLength = this.machine.history.length;
    const shouldBootstrap = this.config.isLive && (
      !this.hasBootstrappedHistory ||
      currentHistoryLength > this.lastBootstrappedHistoryLength + 5
    );

    if (shouldBootstrap && currentHistoryLength > 0) {
      const historyContext = this.renderHistoryForBootstrap(this.machine.history);
      if (historyContext) {
        instructions = `${historyContext}\n\n---\n\n${instructions}`;
        this.hasBootstrappedHistory = true;
        this.lastBootstrappedHistoryLength = currentHistoryLength;
        this.log(`Bootstrapped history context (${currentHistoryLength} messages)`);
      }
    }

    // Update agent instructions
    this.agent._instructions = instructions;
    this.log(`Updated instructions (${instructions.length} chars)`);

    // Generate tool definitions
    const tools = generateToolDefinitions(
      charter,
      activeInstance.node,
      ancestors.map((a) => a.node),
    );

    // Convert to LiveKit tool format and register
    const lkTools = this.convertToolsToLiveKit(tools);
    const toolNames = lkTools.map((t) => t.name);

    console.log(`[LiveKit Config Push] Active node: ${activeInstance.node.id} (${activeInstance.node.name ?? "unnamed"}), tools: [${toolNames.join(", ")}], timestamp: ${Date.now()}`);

    this.log(`Updating LiveKit agent config: ${lkTools.length} tools`);

    // Register tools with the agent
    this.registerToolsWithLiveKit(lkTools);
  }

  /**
   * Convert markov-machines tool definitions to LiveKit format.
   */
  private convertToolsToLiveKit(
    tools: Array<{ name: string; description?: string; input_schema?: unknown }>,
  ): LiveKitToolDefinition[] {
    return tools
      .filter((t) => t.input_schema) // Skip built-in tools without schema
      .map((t) => ({
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema as LiveKitToolDefinition["parameters"],
      }));
  }

  /**
   * Register tools with LiveKit agent.
   * Each tool, when called by LiveKit, runs through our tool pipeline.
   */
  private registerToolsWithLiveKit(tools: LiveKitToolDefinition[]): void {
    if (!this.agent) {
      this.log("No agent to register tools with");
      return;
    }

    // Build LiveKit tool context from our tool definitions
    const toolContext: llm.ToolContext = {};

    for (const toolDef of tools) {
      // Create a LiveKit tool that calls back into our machine
      const lkTool = llm.tool({
        description: toolDef.description,
        parameters: toolDef.parameters as any, // JSON schema format
        execute: async (args: Record<string, unknown>) => {
          const callId = generateToolCallId();
          return this.handleToolCall({
            id: callId,
            name: toolDef.name,
            input: args,
          });
        },
      });

      toolContext[toolDef.name] = lkTool as llm.FunctionTool<any, any, any>;
    }

    // Update the agent's tools
    this.agent._tools = toolContext;

    this.log(`Registered ${tools.length} tools with LiveKit: ${tools.map((t) => t.name).join(", ")}`);
  }

  /**
   * Handle a tool call from LiveKit.
   * Runs the tool through our pipeline and returns the result.
   *
   * Tool calls run in parallel (no mutex). Failures are enqueued as error messages.
   */
  async handleToolCall(call: ToolCall): Promise<string> {

    if (!this.machine) {
      return "Error: Machine not connected";
    }

    const machine = this.machine;
    const instanceId = machine.instance.id;

    this.log(`Tool call: ${call.name} (id: ${call.id})`);

    // Enqueue tool_use message immediately
    machine.enqueue([
      assistantMessage([
        { type: "tool_use", id: call.id, name: call.name, input: call.input },
      ]),
    ]);

    try {
      // Check if instance still exists
      if (!findInstanceById(machine.instance, instanceId)) {
        throw new Error(`Instance ${instanceId} no longer exists in tree`);
      }

      // Build context for tool pipeline
      const charter = machine.charter;
      const rootInstance = machine.instance;
      const instancePath = getInstancePath(rootInstance);
      const activeInstance = instancePath[instancePath.length - 1]!;
      const ancestors = instancePath.slice(0, -1);
      const packStates = rootInstance.packStates ?? {};

      // Temporary queue to collect messages from the pipeline
      const pipelineQueue: MachineMessage[] = [];
      const pipelineEnqueue = (msgs: MachineMessage[]) => pipelineQueue.push(...msgs);

      // Run the tool pipeline - it enqueues all messages
      const result = await runToolPipeline(
        {
          charter,
          instance: activeInstance,
          ancestors,
          packStates,
          history: machine.history,
          enqueue: pipelineEnqueue,
          source: { instanceId: activeInstance.id },
        },
        [call],
      );

      // Check again after async work
      if (!findInstanceById(machine.instance, instanceId)) {
        throw new Error(`Instance ${instanceId} was replaced during tool execution`);
      }

      // Extract tool result content from the pipeline queue
      const toolResultContent = this.extractToolResultContent(pipelineQueue);

      // Enqueue ALL messages from the pipeline (including instance messages).
      // runMachine will drain them, apply instance mutations, and yield a step
      // that gets persisted to Convex. This keeps state in sync.
      if (pipelineQueue.length > 0) {
        machine.enqueue(pipelineQueue);
      }

      // Note: We don't apply instance mutations or update LiveKit config here.
      // That happens when runMachine processes the queue and yields a step.
      // The agent's main loop will then persist the updated instance to Convex.

      return toolResultContent;
    } catch (error) {
      const errorMsg = `Tool "${call.name}" failed: ${error instanceof Error ? error.message : String(error)}`;
      this.log(`Tool error: ${errorMsg}`);

      // Enqueue failure as user message
      machine.enqueue([
        userMessage([
          { type: "tool_result", tool_use_id: call.id, content: errorMsg, is_error: true },
        ]),
      ]);

      return errorMsg;
    }
  }

  /**
   * Extract tool result content from pipeline messages.
   */
  private extractToolResultContent(messages: MachineMessage[]): string {
    // Look for tool_result blocks in user messages
    for (const msg of messages) {
      if ("role" in msg && msg.role === "user" && Array.isArray(msg.items)) {
        for (const item of msg.items) {
          if (
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            item.type === "tool_result" &&
            "content" in item
          ) {
            return String(item.content);
          }
        }
      }
    }
    return "Tool completed";
  }

  /**
   * Log a debug message if debug is enabled.
   */
  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[LiveKitExecutor] ${message}`);
    }
  }
}
