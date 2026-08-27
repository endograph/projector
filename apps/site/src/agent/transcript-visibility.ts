export const HIDDEN_TRANSCRIPT = "hidden" as const;

export function isTranscriptVisible(message: unknown): boolean {
  if (!message || typeof message !== "object") return true;
  return (message as { transcript?: unknown }).transcript !== HIDDEN_TRANSCRIPT;
}
