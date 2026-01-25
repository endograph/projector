import { Room, RoomEvent, TrackKind } from "@livekit/rtc-node";
import type { RemoteTrack, RemoteParticipant } from "@livekit/rtc-node";
import type { LiveKitOptions } from "./types.js";

/**
 * LiveKit room adapter.
 * Handles connecting to a LiveKit room and managing audio tracks.
 */
export class LiveKitAdapter {
  private room: Room | null = null;
  private debug: boolean;

  constructor(options: { debug?: boolean } = {}) {
    this.debug = options.debug ?? false;
  }

  /**
   * Connect to a LiveKit room.
   */
  async connect(options: LiveKitOptions): Promise<Room> {
    if (this.room) {
      throw new Error("Already connected to a room");
    }

    this.room = new Room();

    // Set up event handlers before connecting
    this.setupEventHandlers();

    if (this.debug) {
      console.log("[LiveKitAdapter] Connecting to room:", options.roomName);
    }

    await this.room.connect(options.serverUrl, options.token);

    if (this.debug) {
      console.log("[LiveKitAdapter] Connected to room");
    }

    return this.room;
  }

  /**
   * Disconnect from the LiveKit room.
   */
  async disconnect(): Promise<void> {
    if (this.room) {
      await this.room.disconnect();
      this.room = null;

      if (this.debug) {
        console.log("[LiveKitAdapter] Disconnected from room");
      }
    }
  }

  /**
   * Get the current room instance.
   */
  getRoom(): Room | null {
    return this.room;
  }

  /**
   * Check if connected to a room.
   */
  get isConnected(): boolean {
    return this.room !== null;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private setupEventHandlers(): void {
    if (!this.room) return;

    // Track subscribed - log for debugging
    // Note: Audio processing is handled by the LiveKit Agent
    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication, participant: RemoteParticipant) => {
      if (track.kind === TrackKind.KIND_AUDIO && this.debug) {
        console.log("[LiveKitAdapter] Audio track subscribed from:", participant.identity);
      }
    });

    // Track unsubscribed
    this.room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _publication, participant: RemoteParticipant) => {
      if (track.kind === TrackKind.KIND_AUDIO) {
        if (this.debug) {
          console.log("[LiveKitAdapter] Audio track unsubscribed from:", participant.identity);
        }
      }
    });

    // Participant connected
    this.room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      if (this.debug) {
        console.log("[LiveKitAdapter] Participant connected:", participant.identity);
      }
    });

    // Participant disconnected
    this.room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      if (this.debug) {
        console.log("[LiveKitAdapter] Participant disconnected:", participant.identity);
      }
    });

    // Disconnected from room
    this.room.on(RoomEvent.Disconnected, () => {
      if (this.debug) {
        console.log("[LiveKitAdapter] Disconnected from room");
      }
      this.room = null;
    });
  }

}
