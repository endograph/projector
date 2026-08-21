import type { AiSdkExecutorConfig } from "@projectors/aisdk-executor";
import type { LanguageModel } from "ai";
import { env } from "./_generated/server";

export const SITE_MODEL_ID = env.OPENAI_MODEL ?? "gpt-5.6-sol";

/**
 * Canonical provider-facing configuration for both real execution and prompt
 * inspection. Execution-only concerns such as streaming and action dispatch
 * are layered on by the production executor.
 */
export function sitePromptExecutorConfig(model: LanguageModel): AiSdkExecutorConfig {
  return {
    model,
    maxOutputTokens: 4096,
    providerOptions: { openai: { parallelToolCalls: true } },
    messageToModelMessage: (message) => {
      if (message.type !== "user" || !message.actor || message.text === undefined) {
        return undefined;
      }
      const attribution = JSON.stringify({
        id: message.actor.id,
        label: message.actor.label,
        kind: message.actor.kind,
      });
      // The charter tells the model this tag is trusted attribution, so a
      // forged copy typed into the message body must not survive verbatim.
      const text = message.text.replace(/<(\/?projector-actor)/g, "&lt;$1");
      return {
        role: "user",
        content: `<projector-actor>${attribution}</projector-actor>\n${text}`,
      };
    },
  };
}
