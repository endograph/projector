import type { Instance } from "../types/instance.js";
import type { Node } from "../types/node.js";
import type { Transition } from "../types/transitions.js";
import type { Charter } from "../types/charter.js";

export interface SystemPromptOptions {
  currentStep?: number;
  maxSteps?: number;
}

/**
 * Build the complete system prompt for a node execution.
 * If the charter has a custom buildSystemPrompt function, it will be used.
 * Otherwise, the default system prompt builder is used.
 */
export function buildSystemPrompt<S>(
  charter: Charter<any>,
  node: Node<any, S>,
  state: S,
  ancestors: Instance[],
  packStates: Record<string, unknown>,
  options?: SystemPromptOptions
): string {
  // Use custom builder if provided by charter
  if (charter.buildSystemPrompt) {
    return charter.buildSystemPrompt(charter, node, state, ancestors, packStates, options)
  }

  // Fall back to default system prompt builder
  let prompt = buildDefaultSystemPrompt(node, state, ancestors, packStates, options);

  // Prepend charter instructions if present
  if (charter.instructions) {
    prompt = `${charter.instructions}\n\n${prompt}`;
  }

  return prompt;
}

/**
 * Default system prompt builder.
 * Includes node instructions, current state, available transitions,
 * ancestor context, pack states, and step warnings.
 * For worker nodes, pack context is omitted.
 */
export function buildDefaultSystemPrompt<S>(
  node: Node<any, S>,
  state: S,
  ancestors: Instance[],
  packStates: Record<string, unknown>,
  options?: SystemPromptOptions
): string {
  let prompt = `${node.instructions}

${buildStateSection(state)}

${buildTransitionsSection(node.transitions)}`;

  // Add ancestor context if any
  if (ancestors.length > 0) {
    prompt += `\n\n${buildAncestorContext(ancestors)}`;
  }

  // Add active packs section (only for non-worker nodes)
  // Worker nodes don't have packs and shouldn't see pack context
  if (!node.worker) {
    const packsSection = buildPacksSection(node, packStates);
    if (packsSection) {
      prompt += `\n\n${packsSection}`;
    }
  }

  // Add step limit warning if nearing max
  const stepWarning = buildStepWarning(options);
  if (stepWarning) {
    prompt += `\n\n${stepWarning}`;
  }

  return prompt;
}

/**
 * Build the state section of the system prompt.
 */
export function buildStateSection<S>(state: S): string {
  return `## Current Node State
\`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\``;
}

/**
 * Build the transitions section of the system prompt.
 */
export function buildTransitionsSection<S>(
  transitions: Record<string, Transition<S>>,
): string {
  const transitionList = Object.entries(transitions)
    .map(([name, t]) => {
      let desc = "Transition";
      if ("description" in t && typeof t.description === "string") {
        desc = t.description;
      }
      return `- **${name}**: ${desc}`;
    })
    .join("\n");

  return `## Available Transitions
${transitionList || "None"}

**Important**: After calling a transition tool, you MUST respond to the user in your next message. Greet them or acknowledge the transition context - do not end your turn silently.`;
}

/**
 * Build ancestor context section.
 */
export function buildAncestorContext(ancestors: Instance[]): string {
  const sections = ancestors.map((ancestor, i) => {
    const depth = ancestors.length - i;
    return `### Ancestor ${depth}: ${ancestor.node.instructions.slice(0, 100)}...
State: ${JSON.stringify(ancestor.state, null, 2)}`;
  });

  return `## Ancestor Context
${sections.join("\n\n")}`;
}

/**
 * Build the active packs section of the system prompt.
 */
export function buildPacksSection<S>(
  node: Node<any, S>,
  packStates: Record<string, unknown>,
): string {
  const activePacks = node.packs ?? [];
  if (activePacks.length === 0) return "";

  const sections = activePacks.map((pack) => {
    const state = packStates[pack.name];
    return `### ${pack.name}
${pack.description}
State: \`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\``;
  });

  return `## Active Packs\n${sections.join("\n\n")}`;
}

/**
 * Build a step limit warning message if nearing or at max steps.
 * Returns different urgency levels based on remaining steps.
 */
export function buildStepWarning(options?: SystemPromptOptions): string | null {
  if (!options?.currentStep || !options?.maxSteps) {
    return null;
  }

  const { currentStep, maxSteps } = options;
  const remaining = maxSteps - currentStep;

  if (remaining <= 0) {
    return `⚠️ CRITICAL: This is your FINAL step. You MUST respond to the user now with whatever progress you have made. Do not use any tools.`;
  } else if (remaining === 1) {
    return `⚠️ WARNING: You have only 1 step remaining after this one. Wrap up your work and prepare to respond to the user.`;
  } else if (remaining <= 2) {
    return `⚠️ NOTICE: You have ${remaining} steps remaining. Start wrapping up your work soon.`;
  }

  return null;
}
