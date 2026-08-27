import { describe, expect, test } from "vitest";
import { HIDDEN_TRANSCRIPT, isTranscriptVisible } from "./transcript-visibility";

describe("transcript visibility", () => {
  test("keeps ordinary actor messages visible", () => {
    expect(isTranscriptVisible({ type: "user", text: "hello" })).toBe(true);
  });

  test("hides durable app-pane stimuli from the transcript", () => {
    expect(
      isTranscriptVisible({
        type: "user",
        text: "[App pane interaction] Increment the counter",
        transcript: HIDDEN_TRANSCRIPT,
      }),
    ).toBe(false);
  });
});
