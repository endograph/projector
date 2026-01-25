import type { Room } from "@livekit/rtc-node";
import { voice, llm } from "@livekit/agents";
import type {
  VoiceRuntimeConfig,
  VoiceEvent,
  RealtimeToolDefinition,
} from "./types.js";

// Type aliases for convenience
type Agent = voice.Agent<unknown>;
type AgentSession = voice.AgentSession<unknown>;
type ToolContext = llm.ToolContext;

/**
 * Callback type for realtime events.
 */
export type RealtimeEventCallback = (event: VoiceEvent) => void;

/**
 * Pending function call from the realtime model.
 */
export interface PendingFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

/**
 * Result of a voice turn.
 */
export interface TurnResult {
  /** User's speech transcript */
  userTranscript: string;
  /** Assistant's response transcript */
  assistantTranscript: string;
  /** Function calls made during this turn */
  functionCalls: PendingFunctionCall[];
  /** Whether the turn was interrupted */
  wasInterrupted: boolean;
}

/**
 * Internal state for tracking a turn in progress.
 */
interface TurnState {
  userTranscript: string;
  assistantTranscript: string;
  functionCalls: PendingFunctionCall[];
  wasInterrupted: boolean;
  assistantSpoke: boolean;  // Track if assistant actually spoke
  resolve: (result: TurnResult) => void;
}

/**
 * Wrapper around LiveKit's Agent and AgentSession.
 * Manages the voice session via LiveKit agents.
 */
export class RealtimeClient {
  private config: VoiceRuntimeConfig;
  private eventCallback: RealtimeEventCallback | null = null;
  private room: Room | null = null;
  private agent: Agent | null = null;
  private session: AgentSession | null = null;
  private currentInstructions: string = "";
  private currentTools: RealtimeToolDefinition[] = [];
  private _sessionId: string | null = null;
  private _isConnected: boolean = false;

  // Turn tracking
  private currentTurn: TurnState | null = null;
  private pendingTurnPromise: Promise<TurnResult> | null = null;

  // Tool execution callback (set by voice-machine-runner)
  private toolExecutor: ((name: string, args: string) => Promise<string>) | null = null;

  constructor(config: VoiceRuntimeConfig) {
    this.config = config;
  }

  /**
   * Set the callback for events.
   */
  setEventCallback(callback: RealtimeEventCallback): void {
    this.eventCallback = callback;
  }

  /**
   * Set the tool executor callback.
   * This is called when the model wants to execute a tool.
   */
  setToolExecutor(executor: (name: string, args: string) => Promise<string>): void {
    this.toolExecutor = executor;
  }

  /**
   * Get the session ID.
   */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /**
   * Whether the client is connected.
   */
  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Initialize the realtime client with a LiveKit room.
   */
  async initialize(room: Room): Promise<void> {
    this.room = room;
    this._sessionId = `realtime-${Date.now()}`;

    if (this.config.debug) {
      console.log("[RealtimeClient] Initializing with room");
    }
  }

  /**
   * Start the agent session with initial instructions and tools.
   */
  async startSession(
    instructions: string,
    tools: RealtimeToolDefinition[],
  ): Promise<void> {
    if (!this.room) {
      throw new Error("Room not initialized. Call initialize() first.");
    }

    this.currentInstructions = instructions;
    this.currentTools = tools;

    // Convert tools to LiveKit format
    const toolCtx = this.createToolContext(tools);

    // Create the LiveKit Agent
    // Note: The actual LLM/STT/TTS can be configured via the config
    // For now, we use the defaults which require the user to have
    // the appropriate plugins/providers configured
    this.agent = new voice.Agent({
      instructions,
      tools: toolCtx,
      // LLM, STT, TTS will use defaults or can be configured via config
      // turnDetection defaults to 'realtime_llm' if using realtime model,
      // or 'vad' for traditional pipeline
    });

    // Create and start the session
    this.session = new voice.AgentSession({});

    // Wire up event handlers
    this.setupEventHandlers();

    // Start the session with the room
    await this.session.start({
      agent: this.agent,
      room: this.room,
    });

    this._isConnected = true;
    this.emit({ type: "session_started", sessionId: this._sessionId! });

    if (this.config.debug) {
      console.log("[RealtimeClient] Session started");
    }
  }

  /**
   * Update the session instructions.
   */
  async updateInstructions(instructions: string): Promise<void> {
    this.currentInstructions = instructions;

    if (this.agent && this.session) {
      // Create a new agent with updated instructions
      const toolCtx = this.createToolContext(this.currentTools);

      const newAgent = new voice.Agent({
        instructions,
        tools: toolCtx,
      });

      this.session.updateAgent(newAgent);
      this.agent = newAgent;
    }

    if (this.config.debug) {
      console.log("[RealtimeClient] Instructions updated");
    }
  }

  /**
   * Update the session tools.
   */
  async updateTools(tools: RealtimeToolDefinition[]): Promise<void> {
    this.currentTools = tools;

    if (this.agent && this.session) {
      // Create a new agent with updated tools
      const toolCtx = this.createToolContext(tools);

      const newAgent = new voice.Agent({
        instructions: this.currentInstructions,
        tools: toolCtx,
      });

      this.session.updateAgent(newAgent);
      this.agent = newAgent;
    }

    if (this.config.debug) {
      console.log("[RealtimeClient] Tools updated:", tools.length);
    }
  }

  /**
   * Wait for the next voice turn to complete.
   * Returns the turn result once the user has spoken and the assistant has responded.
   */
  async waitForTurn(): Promise<TurnResult> {
    // If there's already a pending turn, wait for it
    if (this.pendingTurnPromise) {
      return this.pendingTurnPromise;
    }

    // Create a new turn promise
    this.pendingTurnPromise = new Promise<TurnResult>((resolve) => {
      this.currentTurn = {
        userTranscript: "",
        assistantTranscript: "",
        functionCalls: [],
        wasInterrupted: false,
        assistantSpoke: false,
        resolve,
      };
    });

    return this.pendingTurnPromise;
  }

  /**
   * Interrupt the current generation.
   */
  interrupt(): void {
    if (this.session) {
      this.session.interrupt();
    }

    if (this.currentTurn) {
      this.currentTurn.wasInterrupted = true;
    }

    this.emit({ type: "interrupted" });

    if (this.config.debug) {
      console.log("[RealtimeClient] Interrupted");
    }
  }

  /**
   * Close the realtime session.
   */
  async close(): Promise<void> {
    if (this.session) {
      await this.session.close();
      this.session = null;
    }

    this.agent = null;
    this._isConnected = false;
    this.room = null;
    this._sessionId = null;

    if (this.config.debug) {
      console.log("[RealtimeClient] Session closed");
    }
  }

  /**
   * Get the current instructions.
   */
  get instructions(): string {
    return this.currentInstructions;
  }

  /**
   * Get the current tools.
   */
  get tools(): RealtimeToolDefinition[] {
    return this.currentTools;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Convert RealtimeToolDefinition[] to LiveKit's ToolContext format.
   */
  private createToolContext(tools: RealtimeToolDefinition[]): ToolContext {
    const toolCtx: ToolContext = {};

    for (const toolDef of tools) {
      toolCtx[toolDef.name] = llm.tool({
        description: toolDef.description,
        parameters: toolDef.parameters,
        execute: async (args: Record<string, unknown>) => {
          // Emit event for tool call started
          const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          this.emit({
            type: "tool_call_started",
            callId,
            name: toolDef.name,
          });

          // Record the function call in the current turn
          if (this.currentTurn) {
            this.currentTurn.functionCalls.push({
              callId,
              name: toolDef.name,
              arguments: JSON.stringify(args),
            });
          }

          // Execute the tool via the callback
          let result: string;
          if (this.toolExecutor) {
            try {
              result = await this.toolExecutor(toolDef.name, JSON.stringify(args));
            } catch (error) {
              result = `Error: ${error instanceof Error ? error.message : String(error)}`;
            }
          } else {
            result = "Tool executor not configured";
          }

          // Emit event for tool call completed
          this.emit({
            type: "tool_call_completed",
            callId,
            name: toolDef.name,
            result,
          });

          return result;
        },
      });
    }

    return toolCtx;
  }

  /**
   * Set up event handlers for the agent session.
   */
  private setupEventHandlers(): void {
    if (!this.session) return;

    // User state changed (speaking/listening/away)
    this.session.on(
      voice.AgentSessionEventTypes.UserStateChanged,
      (ev: voice.UserStateChangedEvent) => {
        if (this.config.debug) {
          console.log(`[RealtimeClient] User state: ${ev.oldState} -> ${ev.newState}`);
        }

        // When user starts speaking, emit speech_started
        if (ev.newState === "speaking" && ev.oldState !== "speaking") {
          this.emit({ type: "speech_started" });
        }
      }
    );

    // User speech transcribed
    this.session.on(
      voice.AgentSessionEventTypes.UserInputTranscribed,
      (ev: voice.UserInputTranscribedEvent) => {
        if (ev.isFinal && this.currentTurn) {
          this.currentTurn.userTranscript = ev.transcript;
          this.emit({ type: "speech_ended", transcript: ev.transcript });
        }
      }
    );

    // Agent state changed
    this.session.on(
      voice.AgentSessionEventTypes.AgentStateChanged,
      (ev: voice.AgentStateChangedEvent) => {
        if (this.config.debug) {
          console.log(`[RealtimeClient] Agent state: ${ev.oldState} -> ${ev.newState}`);
        }

        // When agent starts speaking, emit response_started and track it
        if (ev.newState === "speaking") {
          if (this.currentTurn) {
            this.currentTurn.assistantSpoke = true;
          }
          this.emit({ type: "response_started" });
        }

        // When agent goes back to idle/listening after speaking, the turn is complete
        // Only complete if the assistant actually spoke (avoid premature completion)
        if (
          ev.oldState === "speaking" &&
          (ev.newState === "idle" || ev.newState === "listening")
        ) {
          this.completeTurn();
        }
      }
    );

    // Conversation item added (assistant messages)
    this.session.on(
      voice.AgentSessionEventTypes.ConversationItemAdded,
      (ev: voice.ConversationItemAddedEvent) => {
        if (ev.item.role === "assistant" && this.currentTurn) {
          const text = ev.item.textContent;
          if (text) {
            this.currentTurn.assistantTranscript = text;
          }
        }
      }
    );

    // Function tools executed - note: tools are already tracked via createToolContext
    // This handler is a backup for any tools executed outside our tracking
    this.session.on(
      voice.AgentSessionEventTypes.FunctionToolsExecuted,
      (ev: voice.FunctionToolsExecutedEvent) => {
        if (this.currentTurn) {
          for (const fc of ev.functionCalls) {
            // Only add if not already tracked (via our tool executor)
            // fc.args is LiveKit's property name for arguments
            const existing = this.currentTurn.functionCalls.find(
              (c) => c.name === fc.name && c.arguments === fc.args
            );
            if (!existing) {
              this.currentTurn.functionCalls.push({
                callId: fc.callId,
                name: fc.name,
                arguments: fc.args,
              });
            }
          }
        }
      }
    );

    // Errors
    this.session.on(voice.AgentSessionEventTypes.Error, (ev: voice.ErrorEvent) => {
      const error = ev.error instanceof Error ? ev.error : new Error(String(ev.error));
      this.emit({ type: "error", error });
    });
  }

  /**
   * Complete the current turn and resolve the promise.
   */
  private completeTurn(): void {
    if (!this.currentTurn) return;

    const result: TurnResult = {
      userTranscript: this.currentTurn.userTranscript,
      assistantTranscript: this.currentTurn.assistantTranscript,
      functionCalls: this.currentTurn.functionCalls,
      wasInterrupted: this.currentTurn.wasInterrupted,
    };

    // Emit response ended event
    if (result.assistantTranscript) {
      this.emit({ type: "response_ended", transcript: result.assistantTranscript });
    }

    // Resolve the promise
    this.currentTurn.resolve(result);
    this.currentTurn = null;
    this.pendingTurnPromise = null;
  }

  private emit(event: VoiceEvent): void {
    if (this.eventCallback) {
      try {
        this.eventCallback(event);
      } catch (error) {
        console.error("[RealtimeClient] Error in event callback:", error);
      }
    }
  }
}
