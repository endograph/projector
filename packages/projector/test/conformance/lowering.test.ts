import { describe, expect, it } from "vitest";
import {
  buildAiSdkMessages,
  buildAiSdkSystem,
  buildAiSdkSystemMessages,
  buildAiSdkTools,
} from "@projectors/aisdk-executor";
import {
  buildLiveKitInstructions,
  buildLiveKitToolDefinitions,
} from "@projectors/livekit-realtime-executor";
import { z } from "zod";
import {
  compileProjection,
  createComputedPart,
  createLayout,
  createNode,
  createSlot,
  createSourceInstance,
  text,
  tool,
  type CompiledInference,
} from "../../index.ts";
import { charter } from "./helpers.ts";

// Executor lowering laws: given one compiled IR, every executor's realization
// preserves part order within regions, preserves all content (degradations are
// declared fixed rules, never silent drops), and preserves the tool surface.
// Executors re-encode, never author.

const body = createSlot("body", { default: true });
const guidelines = createSlot("guidelines", { title: "Guidelines", merge: "list" });
const volatileTail = createSlot("volatileTail", { volatile: true });
const contextSlot = createSlot("context", { default: true, volatile: true });
const cameraSlot = createSlot("camera", { volatile: true });

const cameraSnapshot = createComputedPart({
  name: "cameraSnapshot",
  slot: cameraSlot,
  compute: () => [
    { type: "text", text: "Latest camera snapshot:" },
    { type: "image", data: "aGk=", mediaType: "image/png", label: "camera" },
  ],
});

const lookup = {
  state: null,
  name: "lookup",
  description: "Lookup things",
  inputSchema: z.object({ query: z.string() }),
};
const archive = {
  state: null,
  name: "archive",
  description: "Archive things",
  inputSchema: z.object({ id: z.string() }),
};

function compiledFixture(options: { deferredTool?: boolean } = {}): CompiledInference {
  const node = createNode({
    key: "n",
    tools: [lookup],
    parts: [
      text("stable prose"),
      text(guidelines, "rule a"),
      text(guidelines, "rule b"),
      text(volatileTail, "volatile status"),
      text(contextSlot, "Mode: voice."),
      cameraSnapshot,
      ...(options.deferredTool ? [tool(archive, { exposure: "deferred" })] : []),
    ],
  });
  return compileProjection(createSourceInstance({ id: "i", node }), {
    charter: charter({
      nodes: [node],
      slots: [body, guidelines, volatileTail, contextSlot, cameraSlot],
      computedParts: [cameraSnapshot],
      layouts: [
        createLayout({
          name: "doc",
          regions: {
            preamble: [body, guidelines, volatileTail],
            recency: [contextSlot, cameraSlot],
          },
        }),
      ],
    }),
  });
}

function regionTexts(parts: CompiledInference["preamble"]): string[] {
  return parts.flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text] : []));
}

/** Each needle appears after the previous one — order within a region survives lowering. */
function expectOrderedSubsequence(haystack: string, needles: string[]): void {
  let cursor = -1;
  for (const needle of needles) {
    const index = haystack.indexOf(needle, cursor + 1);
    expect(index, `"${needle}" missing or out of order`).toBeGreaterThan(cursor);
    cursor = index;
  }
}

const anthropicModel = { provider: "anthropic.messages", modelId: "claude-test" } as never;
const opaqueModel = "opaque-model" as never;

function runRequest(inference: CompiledInference) {
  return {
    activationId: "activation-1",
    generatorId: "instance:i",
    inference,
    enqueueFrame: () => {
      throw new Error("not used");
    },
  };
}

describe("conformance: executor lowering laws", () => {
  it("core stamps every compiled part and orders stable before volatile per region", () => {
    const compiled = compiledFixture();
    for (const region of [compiled.preamble, compiled.recency]) {
      for (const part of region) {
        expect(typeof part.slot).toBe("string");
        expect(typeof part.volatile).toBe("boolean");
        expect(part.region).toBeUndefined();
        expect(part.partDepth).toBeUndefined();
      }
      const firstVolatile = region.findIndex((part) => part.volatile);
      if (firstVolatile !== -1) {
        expect(region.slice(firstVolatile).every((part) => part.volatile)).toBe(true);
      }
    }
  });

  it("aisdk preserves region order and content across system and dynamic context", () => {
    const compiled = compiledFixture();
    const system = buildAiSdkSystem(compiled);
    expectOrderedSubsequence(system, regionTexts(compiled.preamble));

    const messages = buildAiSdkMessages(compiled);
    const realized = JSON.stringify(messages);
    expectOrderedSubsequence(realized, regionTexts(compiled.recency).map((part) => JSON.stringify(part).slice(1, -1)));
    // Images pass through as native image content — never silently dropped.
    expect(realized).toContain('"type":"image"');
  });

  it("livekit preserves region order and degrades images by its declared fixed rule", () => {
    const compiled = compiledFixture();
    const instructions = buildLiveKitInstructions(compiled);
    expectOrderedSubsequence(instructions, [
      ...regionTexts(compiled.preamble),
      ...regionTexts(compiled.recency),
    ]);
    // The text-instructions surface cannot carry images; the declared rule is
    // a metadata placeholder, not a silent drop.
    expect(instructions).toContain("Image content unavailable in LiveKit text prompt");
  });

  it("preserves the native tool surface on both executors", () => {
    const compiled = compiledFixture();
    const aisdkTools = buildAiSdkTools(runRequest(compiled), { model: opaqueModel });
    expect(Object.keys(aisdkTools)).toContain("lookup");
    expect(aisdkTools.lookup?.description).toBe("Lookup things");

    const livekitTools = buildLiveKitToolDefinitions(compiled);
    expect(livekitTools.map((definition) => definition.name)).toContain("lookup");
  });

  it("deferred tools lower to the provider idiom or refuse loudly — never degrade silently", () => {
    const compiled = compiledFixture({ deferredTool: true });
    // No tool-search lowering for an opaque model: refusing beats loading the
    // tool natively under a compiled note that promises tool search.
    expect(() => buildAiSdkTools(runRequest(compiled), { model: opaqueModel })).toThrow(/deferred tools/);
    // The realtime surface has no tool-search mechanism at all: always an error.
    expect(() => buildLiveKitToolDefinitions(compiled)).toThrow(/deferred tools/);
  });

  it("aisdk places exactly one cache breakpoint at the stable/volatile boundary", () => {
    const compiled = compiledFixture();
    const messages = buildAiSdkSystemMessages(compiled, anthropicModel);
    expect(Array.isArray(messages)).toBe(true);
    const blocks = messages as Array<{ content: string; providerOptions?: Record<string, unknown> }>;

    const cached = blocks.filter((block) => {
      const anthropic = block.providerOptions?.anthropic as Record<string, unknown> | undefined;
      return Boolean(anthropic?.cacheControl);
    });
    expect(cached).toHaveLength(1);
    expect(cached[0]).toBe(blocks[0]);
    expect(cached[0]?.content).toContain("stable prose");
    expect(cached[0]?.content).not.toContain("volatile status");
    expect(blocks[1]?.content).toContain("volatile status");

    // Re-encoding, not authoring: the block text concatenates to the exact
    // single-string system prompt every other provider receives.
    expect(blocks.map((block) => block.content).join("\n\n")).toBe(buildAiSdkSystem(compiled));
  });
});
