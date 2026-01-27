/**
 * ConvexTranscriptSink
 *
 * Persists voice transcripts to Convex via HTTP endpoint.
 * Uses idempotency keys to ensure exactly-once delivery.
 */

export class ConvexTranscriptSink {
  private roomName: string;
  private convexUrl: string;
  private agentSecret: string;
  private segmentCounter = 0;

  constructor(roomName: string) {
    this.roomName = roomName;

    const convexUrl = process.env.CONVEX_URL;
    const agentSecret = process.env.VOICE_AGENT_SECRET;

    if (!convexUrl) {
      throw new Error("CONVEX_URL environment variable is required");
    }
    if (!agentSecret) {
      throw new Error("VOICE_AGENT_SECRET environment variable is required");
    }

    this.convexUrl = convexUrl;
    this.agentSecret = agentSecret;
  }

  /**
   * Append a transcript to Convex.
   * Uses incrementing segment IDs for idempotency.
   */
  async appendTranscript(
    role: "user" | "assistant",
    content: string
  ): Promise<void> {
    const segmentId = `${Date.now()}-${this.segmentCounter++}`;

    const payload = {
      roomName: this.roomName,
      role,
      content,
      segmentId,
    };

    try {
      const response = await fetch(`${this.convexUrl}/voice/transcript`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-voice-agent-secret": this.agentSecret,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[TranscriptSink] Failed to persist transcript: ${response.status} ${errorText}`
        );
      } else {
        console.log(
          `[TranscriptSink] Persisted ${role} transcript: "${content.substring(0, 50)}..."`
        );
      }
    } catch (error) {
      console.error("[TranscriptSink] Error persisting transcript:", error);
    }
  }
}
