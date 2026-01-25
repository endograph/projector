import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import { fileURLToPath } from "node:url";
import { ConvexTranscriptSink } from "./transcript-sink.js";
import dotenv from "dotenv";

// Note: Bun automatically loads .env files, no dotenv needed


dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const ENABLE_REALTIME = process.env.ENABLE_REALTIME_MODEL === "true";

// Log config on startup
console.log("[VoiceAgent] Configuration:");
console.log(`  ENABLE_REALTIME_MODEL: ${ENABLE_REALTIME}`);
console.log(`  CONVEX_URL: ${process.env.CONVEX_URL ? "set" : "NOT SET"}`);
console.log(`  VOICE_AGENT_SECRET: ${process.env.VOICE_AGENT_SECRET ? "set" : "NOT SET"}`);
console.log(`  OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "set" : "NOT SET"}`);
console.log(`  LIVEKIT_URL: ${process.env.LIVEKIT_URL ?? "NOT SET"}`);

/**
 * Voice Agent for Demo App
 *
 * Supports two modes based on ENABLE_REALTIME_MODEL env var:
 * - Realtime mode: Uses OpenAI Realtime API for low-latency voice-to-voice
 * - Pipeline mode: Uses STT → LLM → TTS for more control
 *
 * Transcripts are persisted to Convex via HTTP endpoint with idempotency.
 */

class VoiceAssistant extends voice.Agent {
  constructor() {
    super({
      instructions: `You are a helpful voice AI assistant. The user is interacting with you via voice.
Your responses should be concise and conversational - this is a spoken dialogue, not written text.
Avoid complex formatting, bullet points, or long explanations.
Be friendly, helpful, and respond naturally as you would in a voice conversation.`,
    });
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    console.log("[VoiceAgent] Prewarm starting...");

    // Preload VAD model for pipeline mode
    if (!ENABLE_REALTIME) {
      console.log("[VoiceAgent] Loading Silero VAD model (pipeline mode)...");
      try {
        proc.userData.vad = await silero.VAD.load();
        console.log("[VoiceAgent] Silero VAD model loaded successfully");
      } catch (error) {
        console.error("[VoiceAgent] Failed to load Silero VAD model:", error);
        console.error("[VoiceAgent] Did you run 'bun run download-files'?");
        throw error;
      }
    } else {
      console.log("[VoiceAgent] Skipping VAD load (realtime mode)");
    }

    console.log("[VoiceAgent] Prewarm complete");
  },

  entry: async (ctx: JobContext) => {
    console.log("[VoiceAgent] Entry called");
    console.log(`[VoiceAgent] Job ID: ${ctx.job.id}`);

    // Create transcript sink - we'll get room name from job metadata or after connect
    let transcriptSink: ConvexTranscriptSink | null = null;

    let session: voice.AgentSession;

    if (ENABLE_REALTIME) {
      // OpenAI Realtime mode - voice-to-voice with built-in turn detection
      console.log("[VoiceAgent] Using OpenAI Realtime mode");

      session = new voice.AgentSession({
        llm: new openai.realtime.RealtimeModel({
          model: "gpt-4o-realtime-preview",
          voice: "alloy",
          // Turn detection configuration
          turnDetection: {
            type: "server_vad",
            threshold: 0.5,
            silence_duration_ms: 500,
          },
          // Enable input audio transcription with whisper
          inputAudioTranscription: {
            model: "whisper-1",
          },
        }),
      });
    } else {
      // Pipeline mode - STT → LLM → TTS
      console.log("[VoiceAgent] Using STT->LLM->TTS pipeline mode");

      session = new voice.AgentSession({
        stt: new openai.STT(),
        llm: new openai.LLM({ model: "gpt-4o-mini" }),
        tts: new openai.TTS({ voice: "alloy" }),
        vad: ctx.proc.userData.vad as silero.VAD,
      });
    }

    // Listen for transcription events to persist to Convex
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, async (ev) => {
      console.log(`[VoiceAgent] User transcription: "${ev.transcript}" (final: ${ev.isFinal})`);
      if (ev.isFinal && transcriptSink) {
        await transcriptSink.appendTranscript("user", ev.transcript);
      }
    });

    // Listen for conversation items (includes assistant messages)
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, async (ev) => {
      const item = ev.item;
      console.log(`[VoiceAgent] Conversation item added: role=${item.role}, content type=${typeof item.content}`);
      if (item.role === "assistant" && typeof item.content === "string" && transcriptSink) {
        await transcriptSink.appendTranscript("assistant", item.content);
      }
    });

    // Listen for state changes
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.log(`[VoiceAgent] State changed: ${ev.oldState} -> ${ev.newState}`);
    });

    // Listen for errors
    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      console.error(`[VoiceAgent] Error:`, ev.error);
    });

    // Start the session BEFORE connecting (this sets up track subscriptions)
    console.log("[VoiceAgent] Starting agent session...");
    await session.start({
      agent: new VoiceAssistant(),
      room: ctx.room,
    });

    // Now connect to the room
    console.log("[VoiceAgent] Connecting to room...");
    await ctx.connect();

    const roomName = ctx.room.name ?? "";
    console.log(`[VoiceAgent] Connected to room: ${roomName}`);

    // Set up transcript sink now that we have the room name
    if (roomName) {
      try {
        transcriptSink = new ConvexTranscriptSink(roomName);
        console.log("[VoiceAgent] Transcript sink created");
      } catch (error) {
        console.error("[VoiceAgent] Failed to create transcript sink:", error);
      }
    }

    console.log(`[VoiceAgent] Agent ready in room: ${roomName}`);
  },
});

// Run the agent
cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
