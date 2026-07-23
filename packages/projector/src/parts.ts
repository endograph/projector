import { isComputedPartDef } from "./computed-parts.ts";
import type {
  ActionCaller,
  ActionConfigEntry,
  ActionPart,
  Exposure,
  IncludePart,
  Node,
  Part,
  PartEntry,
  Ref,
  SlotAddress,
  TextPart,
} from "./types.ts";

/**
 * A text contribution addressed to a slot or region (omitted = the preamble
 * region's default slot). Region addresses (`preambleRegion`/`recencyRegion`)
 * resolve to the active layout's default slot for that region, so they stay
 * valid across layout changes.
 */
export function text(slot: SlotAddress, content: string): TextPart;
export function text(content: string): TextPart;
export function text(slotOrContent: SlotAddress | string, content?: string): TextPart {
  if (content === undefined) {
    return { kind: "text", text: slotOrContent as string };
  }
  return { kind: "text", slot: slotOrContent as SlotAddress, text: content };
}

export const textPart = text;

export type ActionPartOptions = {
  /** Companion prose that travels with the contribution (see ActionPart). */
  guidance?: TextPart | TextPart[];
  /** Default native; deferred lowers to provider tool search (see Exposure). */
  exposure?: Exposure;
};

function actionPart<TAction extends ActionConfigEntry>(
  caller: ActionCaller,
  entry: TAction,
  options: ActionPartOptions = {},
): ActionPart<TAction> {
  const guidance = options.guidance === undefined
    ? undefined
    : Array.isArray(options.guidance)
      ? options.guidance
      : [options.guidance];
  return {
    kind: "action",
    caller,
    action: entry,
    ...(options.exposure ? { exposure: options.exposure } : {}),
    ...(guidance ? { guidance } : {}),
  };
}

/** An action operated by the generator (compiled into the tool surface). */
export function tool<const TAction extends ActionConfigEntry>(
  action: TAction,
  options?: ActionPartOptions,
): ActionPart<TAction> {
  return actionPart("generator", action, options);
}

/** An action operated by an external caller (host/client dispatch). */
export function command<const TAction extends ActionConfigEntry>(
  action: TAction,
  options?: ActionPartOptions,
): ActionPart<TAction> {
  return actionPart("external", action, options);
}

/** An action operated by either caller. */
export function action<const TAction extends ActionConfigEntry>(
  entry: TAction,
  caller: ActionCaller = "any",
  options?: ActionPartOptions,
): ActionPart<TAction> {
  return actionPart(caller, entry, options);
}

/**
 * Instance-based composition: a view of the living contributor the given node
 * key resolves to (nearest enclosing scope matching at compile), spliced at
 * this part's position. Pass the node object (typo-proof; the key serializes
 * on the wire) or the node key. No options by design: an include splices the
 * target's full canonical rendering — include-site overrides would break
 * byte-identity with the canonical rendering.
 */
export function include<TDataContent = never>(
  node: Node<TDataContent> | Ref,
): IncludePart<TDataContent> {
  return { kind: "include", node };
}

/** The node key an include part references (object at authoring, key on the wire). */
export function includeNodeKey(part: IncludePart<any>): string {
  return typeof part.node === "string" ? part.node : part.node.key;
}

export function isPart(value: unknown): value is Part<any> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return kind === "text" || kind === "action" || kind === "computed" || kind === "include";
}

/**
 * Normalizes authoring part entries: inline computed part definitions become
 * computed refs carried by identity (registration is validated at charter
 * build), everything else passes through.
 */
export function normalizePartEntries<TDataContent>(
  entries: readonly PartEntry<TDataContent>[],
): Part<TDataContent>[] {
  return entries.map((entry) => {
    if (isComputedPartDef(entry)) {
      return { kind: "computed", part: entry };
    }
    return entry;
  });
}

/**
 * Walks every part reachable in a parts list, entering all branches of
 * sugar-lowered selects through their computed metadata (walkable data,
 * always an inline def — sugar defs never register or serialize by ref).
 * Static analysis helper (validation, serialization, registries) — runtime
 * evaluation runs the compute and sees only the chosen branch. Bare computed
 * closures stay opaque; callers consult their registries directly.
 */
export function walkAllParts<TDataContent>(
  parts: readonly Part<TDataContent>[],
  visit: (part: Part<TDataContent>) => void,
): void {
  for (const part of parts) {
    visit(part);
    if (part.kind === "computed" && typeof part.part !== "string" && part.part.metadata) {
      for (const branch of Object.values(part.part.metadata.branches)) {
        if (branch) {
          walkAllParts(branch, visit);
        }
      }
    }
  }
}
