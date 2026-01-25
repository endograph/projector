import { z } from "zod";
import type { Node } from "../types/node.js";
import type { Charter } from "../types/charter.js";
import type { AnthropicToolDefinition } from "../types/tools.js";
import { isAnthropicBuiltinTool } from "../types/tools.js";
import type { Transition } from "../types/transitions.js";
import {
  isCodeTransition,
  isGeneralTransition,
  transitionHasArguments,
} from "../types/transitions.js";
import { resolveTransitionRef } from "../runtime/ref-resolver.js";
import { ZOD_JSON_SCHEMA_TARGET_OPENAPI_3 } from "../helpers/json-schema.js";

/**
 * Track tool sources for collision detection.
 * Maps tool name to its source for error messages.
 */
type ToolSource =
  | "builtin:updateState"
  | "builtin:transition"
  | `builtin:transition_${string}`
  | "node"
  | `ancestor:${string}`
  | "charter"
  | `pack:${string}`;

/**
 * Generate Anthropic tool definitions for a node.
 * Includes: updateState, transition tools, current node tools, ancestor tools, and charter tools.
 * Child tools shadow parent tools (closest match wins).
 * Pack tools are only included for non-worker nodes.
 *
 * @throws Error if a tool name from a lower-priority scope conflicts with a higher-priority scope
 */
export function generateToolDefinitions<S>(
  charter: Charter<any>,
  node: Node<any, S>,
  ancestorNodes: Node<any, unknown>[] = [],
): AnthropicToolDefinition[] {
  const tools: AnthropicToolDefinition[] = [];
  const toolSources = new Map<string, ToolSource>();

  /**
   * Check for tool name collision and throw descriptive error if found.
   */
  function checkCollision(name: string, newSource: ToolSource): void {
    const existingSource = toolSources.get(name);
    if (existingSource) {
      throw new Error(
        `Tool "${name}" from ${newSource} conflicts with existing tool from ${existingSource}`,
      );
    }
  }

  // 1. Add updateState tool
  const patchValidator: z.ZodTypeAny =
    typeof (node.validator as { partial?: () => z.ZodTypeAny }).partial === "function"
      ? (node.validator as z.ZodObject<Record<string, z.ZodTypeAny>>).partial()
      : node.validator;
  const stateSchema: Record<string, unknown> = z.toJSONSchema(patchValidator, {
    target: ZOD_JSON_SCHEMA_TARGET_OPENAPI_3,
  }) as Record<string, unknown>;
  tools.push({
    name: "updateState",
    description:
      "Update the current state with a partial patch. The patch will be shallow-merged with the current state.",
    input_schema: {
      type: "object",
      properties: {
        patch: stateSchema as Record<string, unknown>,
      },
      required: ["patch"],
    },
  });
  toolSources.set("updateState", "builtin:updateState");

  // 2. Add transition tools
  const transitionsWithoutArgs: string[] = [];
  const transitionsWithArgs: Array<{
    name: string;
    description: string;
    argsSchema: Record<string, unknown>;
  }> = [];

  for (const [name, transition] of Object.entries(node.transitions)) {
    const resolved = resolveTransitionRef(charter, transition);
    const hasArgs = transitionHasArguments(resolved);

    if (hasArgs) {
      // Named transition tool
      const argsSchema = getTransitionArgsSchema(resolved);
      transitionsWithArgs.push({
        name,
        description: getTransitionDescription(resolved),
        argsSchema,
      });
    } else {
      transitionsWithoutArgs.push(name);
    }
  }

  // Add default transition tool if there are transitions without args
  if (transitionsWithoutArgs.length > 0) {
    tools.push({
      name: "transition",
      description:
        "Transition to a different node. Use this when the current task is complete or you need different capabilities.",
      input_schema: {
        type: "object",
        properties: {
          to: {
            type: "string",
            enum: transitionsWithoutArgs,
            description: "The name of the transition to take",
          },
          reason: {
            type: "string",
            description: "Why you are making this transition",
          },
        },
        required: ["to", "reason"],
      },
    });
    toolSources.set("transition", "builtin:transition");
  }

  // Add named transition tools
  for (const t of transitionsWithArgs) {
    const toolName = `transition_${t.name}`;
    tools.push({
      name: toolName,
      description: t.description,
      input_schema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why you are making this transition",
          },
          ...t.argsSchema,
        },
        required: ["reason", ...Object.keys(t.argsSchema)],
      },
    });
    toolSources.set(toolName, `builtin:transition_${t.name}` as ToolSource);
  }

  // 3. Add current node's tools (highest priority after builtins)
  for (const [name, tool] of Object.entries(node.tools)) {
    // Node tools cannot shadow builtin tools
    checkCollision(name, "node");

    // Handle Anthropic built-in tools (server-side).
    // Built-in tools have a different shape than standard tools, requiring a cast.
    if (isAnthropicBuiltinTool(tool)) {
      tools.push({ type: tool.builtinType, name: tool.name } as unknown as AnthropicToolDefinition);
      toolSources.set(name, "node");
      continue;
    }

    const inputSchema: Record<string, unknown> = z.toJSONSchema(tool.inputSchema, {
      target: ZOD_JSON_SCHEMA_TARGET_OPENAPI_3,
    }) as Record<string, unknown>;
    tools.push({
      name,
      description: tool.description,
      input_schema: inputSchema as AnthropicToolDefinition["input_schema"],
    });
    toolSources.set(name, "node");
  }

  // 4. Add ancestor tools (from nearest to farthest)
  // Reverse so nearest ancestors are processed first
  for (let i = ancestorNodes.length - 1; i >= 0; i--) {
    const ancestorNode = ancestorNodes[i];
    if (!ancestorNode) continue;
    for (const [name, tool] of Object.entries(ancestorNode.tools)) {
      // Skip if higher-priority scope already has this tool (node or nearer ancestor)
      if (toolSources.has(name)) continue;

      const ancestorSource = `ancestor:${ancestorNode.id}` as ToolSource;

      // Handle Anthropic built-in tools (server-side).
      // Built-in tools have a different shape than standard tools, requiring a cast.
      if (isAnthropicBuiltinTool(tool)) {
        tools.push({ type: tool.builtinType, name: tool.name } as unknown as AnthropicToolDefinition);
        toolSources.set(name, ancestorSource);
        continue;
      }

      const inputSchema: Record<string, unknown> = z.toJSONSchema(tool.inputSchema, {
        target: ZOD_JSON_SCHEMA_TARGET_OPENAPI_3,
      }) as Record<string, unknown>;
      tools.push({
        name,
        description: tool.description,
        input_schema: inputSchema as AnthropicToolDefinition["input_schema"],
      });
      toolSources.set(name, ancestorSource);
    }
  }

  // 5. Add charter tools
  for (const [name, tool] of Object.entries(charter.tools)) {
    // Skip if higher-priority scope already has this tool
    if (toolSources.has(name)) continue;

    const inputSchema: Record<string, unknown> = z.toJSONSchema(tool.inputSchema, {
      target: ZOD_JSON_SCHEMA_TARGET_OPENAPI_3,
    }) as Record<string, unknown>;
    tools.push({
      name,
      description: tool.description,
      input_schema: inputSchema as AnthropicToolDefinition["input_schema"],
    });
    toolSources.set(name, "charter");
  }

  // 6. Add pack tools (lowest priority - only for packs on current node, and only for non-worker nodes)
  // Worker nodes don't have access to packs
  if (!node.worker) {
    for (const pack of node.packs ?? []) {
      for (const [name, tool] of Object.entries(pack.tools)) {
        // Skip if higher-priority scope already has this tool
        if (toolSources.has(name)) continue;

        const inputSchema: Record<string, unknown> = z.toJSONSchema(tool.inputSchema, {
          target: ZOD_JSON_SCHEMA_TARGET_OPENAPI_3,
        }) as Record<string, unknown>;
        tools.push({
          name,
          description: tool.description,
          input_schema: inputSchema as AnthropicToolDefinition["input_schema"],
        });
        toolSources.set(name, `pack:${pack.name}` as ToolSource);
      }
    }
  }

  return tools;
}

/**
 * Get the description for a transition.
 */
function getTransitionDescription<S>(transition: Transition<S>): string {
  if ("description" in transition && typeof transition.description === "string") {
    return transition.description;
  }
  return "Transition to another node";
}

/**
 * Get the arguments schema for a transition with custom args.
 */
function getTransitionArgsSchema<S>(
  transition: Transition<S>,
): Record<string, unknown> {
  if (isCodeTransition(transition) && transition.arguments) {
    const schema: Record<string, unknown> = z.toJSONSchema(transition.arguments, {
      target: ZOD_JSON_SCHEMA_TARGET_OPENAPI_3,
    }) as Record<string, unknown>;
    // Extract just the properties
    if (typeof schema === "object" && "properties" in schema) {
      return (schema as { properties: Record<string, unknown> }).properties;
    }
    return { args: schema };
  }

  if (isGeneralTransition(transition)) {
    // General transition takes an inline node definition
    return {
      node: {
        type: "object",
        description: "Inline node definition",
        properties: {
          instructions: {
            type: "string",
            description: "Instructions for the agent in this node",
          },
          tools: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ref: { type: "string" },
              },
              required: ["ref"],
            },
            description: "Tool references available in this node",
          },
          validator: {
            type: "object",
            description: "Zodex-serialized state schema",
          },
          transitions: {
            type: "object",
            description: "Available transitions from this node",
          },
        },
        required: ["instructions", "tools", "validator", "transitions"],
      },
    };
  }

  if ("arguments" in transition && transition.arguments) {
    // SerialTransition with JSON Schema arguments
    return { args: transition.arguments };
  }

  return {};
}
