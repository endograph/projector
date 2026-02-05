import type { ConversationMessage, MessageSource } from "./messages";

export interface MessageStreamDelta {
  kind: "text" | "thinking";
  contentIndex: number;
  delta: string;
}

export interface MessageStreamError {
  message: string;
  code?: string;
}

export type MessageStreamEvent<AppMessage = unknown> =
  | {
    type: "message_start";
    messageId: string;
    seq: number;
    source: MessageSource;
    message: ConversationMessage<AppMessage>;
  }
  | {
    type: "message_update";
    messageId: string;
    seq: number;
    source: MessageSource;
    delta: MessageStreamDelta;
  }
  | {
    type: "message_end";
    messageId: string;
    seq: number;
    source: MessageSource;
    message: ConversationMessage<AppMessage>;
  }
  | {
    type: "message_error";
    messageId: string;
    seq: number;
    source: MessageSource;
    error: MessageStreamError;
  };

