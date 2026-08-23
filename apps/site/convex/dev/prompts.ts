import { AiSdkExecutor } from "@projectors/aisdk-executor";
import {
  compileProjection,
  inspectCompiledProjectionTree,
  type CompiledContributor,
  type ExecutorRealizedPrompt,
  type Frame,
  type SerializedInstance,
} from "@projectors/core";
import { v } from "convex/values";
import { hydrateSiteInstance, siteCharter } from "../../src/agent/charter";
import { query } from "../_generated/server";
import { restoreConvexJson, stripClientSchemas } from "../convexJson";
import { SITE_MODEL_ID, sitePromptExecutorConfig } from "../executorConfig";
import { listSessionContextFrameDocs, restoreFrame } from "../frameHistory";
import { requireAdmin } from "./access";

type RuntimeTarget = {
  generatorId: string;
  kind: "generator";
  nodeKey: string;
  name?: string;
};

export const current = query({
  args: { sessionId: v.id("sessions") },
  returns: v.union(
    v.null(),
    v.object({
      sessionId: v.id("sessions"),
      runtimes: v.array(
        v.object({
          generatorId: v.string(),
          kind: v.literal("generator"),
          nodeKey: v.string(),
          name: v.optional(v.string()),
          prompt: v.object({ provider: v.string(), input: v.any() }),
        }),
      ),
    }),
  ),
  handler: async (ctx, { sessionId }) => {
    await requireAdmin(ctx);

    const session = await ctx.db.get(sessionId);
    if (!session) return null;

    const latest = await ctx.db
      .query("projectorInstanceLog")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .first();
    if (!latest) return null;

    const serialized = restoreConvexJson(latest.instance) as SerializedInstance;
    const root = hydrateSiteInstance(serialized, sessionId);
    const frames = (await listSessionContextFrameDocs(ctx, session)).map(restoreFrame) as Frame[];
    const runtimes = collectRuntimeTargets(
      inspectCompiledProjectionTree(root, { charter: siteCharter }).roots,
    );
    const executor = createPromptExecutor();

    return stripClientSchemas({
      sessionId,
      runtimes: await Promise.all(
        runtimes.map(async (runtime) => {
          let prompt: ExecutorRealizedPrompt;
          try {
            const inference = compileProjection(root, {
              charter: siteCharter,
              targetGeneratorId: runtime.generatorId,
              frameHistory: frames,
            });
            prompt = await executor.realizePrompt({
              generatorId: runtime.generatorId,
              activationId: "",
              inference,
            });
          } catch (error) {
            prompt = {
              provider: "error",
              input: { message: error instanceof Error ? error.message : String(error) },
            };
          }
          return { ...runtime, prompt };
        }),
      ),
    });
  },
});

function collectRuntimeTargets(nodes: CompiledContributor[]): RuntimeTarget[] {
  const targets: RuntimeTarget[] = [];
  const visit = (node: CompiledContributor) => {
    targets.push({
      generatorId: node.id,
      kind: node.kind,
      nodeKey: node.nodeKey,
      ...(node.name ? { name: node.name } : {}),
    });
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return targets;
}

// Prompt realization must mirror the production executor's provider-facing
// settings, but intentionally omits action execution and streaming: this query
// serializes the request that would be sent now and never invokes the model.
function createPromptExecutor() {
  return new AiSdkExecutor(sitePromptExecutorConfig(modelRef(SITE_MODEL_ID)));
}

function modelRef(modelId: string): never {
  // `openai(modelId)` uses the Responses API provider identity. Keeping that
  // identity exact also preserves provider-specific deferred-tool lowering.
  return { provider: "openai.responses", modelId } as never;
}
