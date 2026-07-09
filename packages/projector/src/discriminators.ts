import { evaluateComputedPartReturn } from "./computed-parts.ts";
import { isNode } from "./create.ts";
import { assertProjectorIdentifier } from "./identifiers.ts";
import { slotPlacement } from "./slots.ts";
import type {
  AnyAction,
  AnyDiscriminator,
  Charter,
  ComputedMemberDef,
  ComputedPartDef,
  ComputedPartEnv,
  ComputedPartRef,
  ComputedReturnPart,
  ContentPart,
  Discriminator,
  DiscriminatorEnv,
  Node,
  Part,
  Ref,
  StateDescriptor,
} from "./types.ts";

export type DiscriminatorConfig<TValue extends string> = {
  name: string;
  values: readonly TValue[];
  /**
   * Declared like an action's state: the descriptor whose resolved value the
   * derivation reads. Resolution is contributor-relative (nearest scope, init
   * fallback), same as ctx.state for actions.
   */
  state?: StateDescriptor | null;
  derive: (env: DiscriminatorEnv) => TValue;
};

/**
 * A charter-defined, contributor-resolved variation axis. The name and value
 * set are the charter's closed vocabulary (enumerable surfaces, exhaustive
 * selects); each select evaluates the derivation against the params and state
 * containers in scope at the selecting contributor.
 */
export function createDiscriminator<const TValue extends string>(
  config: DiscriminatorConfig<TValue>,
): Discriminator<TValue> {
  assertProjectorIdentifier(config.name, "Discriminator name");
  if (config.values.length === 0) {
    throw new Error(`Discriminator "${config.name}" requires at least one value`);
  }
  const seen = new Set<string>();
  for (const value of config.values) {
    if (seen.has(value)) {
      throw new Error(`Discriminator "${config.name}" declares duplicate value "${value}"`);
    }
    seen.add(value);
  }
  return {
    kind: "discriminator",
    name: config.name,
    values: config.values,
    state: config.state ?? null,
    derive: config.derive,
  };
}

export function isDiscriminator(value: unknown): value is AnyDiscriminator {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "discriminator" &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { derive?: unknown }).derive === "function",
  );
}

type SelectBranches<TDiscriminator, TBranch> = TDiscriminator extends Discriminator<infer TValue>
  ? Record<TValue, TBranch | TBranch[] | null>
  : never;

/**
 * Exhaustive variation at the owning node: one branch per discriminator
 * value (TypeScript enforces completeness via the Record over the literal
 * union; the runtime check guards JS callers). Branch entries are parts;
 * null contributes nothing. Sugar over a computed part — see
 * partSelectComputed for the lowering.
 */
export function select<
  TDataContent = never,
  TDiscriminator extends AnyDiscriminator = AnyDiscriminator,
>(
  discriminator: TDiscriminator,
  branches: SelectBranches<TDiscriminator, Part<TDataContent>>,
): ComputedPartRef<TDataContent> {
  const normalized = normalizeBranches(
    branches as Record<string, Part<TDataContent> | Part<TDataContent>[] | null>,
  );
  if (typeof discriminator !== "string") {
    for (const value of Object.keys(normalized)) {
      assertBranchValue(discriminator, value);
    }
    for (const value of discriminator.values) {
      if (!(value in normalized)) {
        throw new Error(`select over "${discriminator.name}" is missing branch "${value}"`);
      }
    }
  }
  return { kind: "computed", part: partSelectComputed(discriminator, false, normalized) };
}

/** Partial form of select: contributes the entry only for the given value. */
export function when<
  TDataContent = never,
  TDiscriminator extends AnyDiscriminator = AnyDiscriminator,
>(
  discriminator: TDiscriminator,
  value: TDiscriminator["values"][number],
  entry: Part<TDataContent> | Part<TDataContent>[],
): ComputedPartRef<TDataContent> {
  // A string ref carries no value set at construction; the branch value is
  // validated at evaluation time through the canonical env path instead.
  if (typeof discriminator !== "string") {
    assertBranchValue(discriminator, value);
  }
  return {
    kind: "computed",
    part: partSelectComputed(discriminator, true, {
      [value]: Array.isArray(entry) ? entry : [entry],
    }),
  };
}

/**
 * Exhaustive member variation: which node(s) are derived per value. Sugar over
 * a computed member — the returned def's registry is auto-derived from all
 * branch nodes (ref-lookup and validation walk it; inline members keep
 * working) and its compute is `env.discriminator(d)` → branch nodes. The
 * TypeScript Record over the value union enforces exhaustiveness; the runtime
 * check guards JS callers.
 */
export function selectMember<
  TDataContent = never,
  TDiscriminator extends AnyDiscriminator = AnyDiscriminator,
>(
  discriminator: TDiscriminator,
  branches: TDiscriminator extends Discriminator<infer TValue>
    ? Record<TValue, Node<TDataContent> | Node<TDataContent>[] | null>
    : never,
): ComputedMemberDef<TDataContent> {
  const normalized = normalizeMemberBranches(
    branches as Record<string, Node<TDataContent> | Node<TDataContent>[] | null>,
  );
  if (typeof discriminator !== "string") {
    for (const value of Object.keys(normalized)) {
      assertBranchValue(discriminator, value);
    }
    for (const value of discriminator.values) {
      if (!(value in normalized)) {
        throw new Error(
          `selectMember over "${discriminator.name}" is missing branch "${value}"`,
        );
      }
    }
  }
  return memberSelectComputed(discriminator, false, normalized);
}

/** Partial member variation: the node(s) are members only for the given value. */
export function whenMember<
  TDataContent = never,
  TDiscriminator extends AnyDiscriminator = AnyDiscriminator,
>(
  discriminator: TDiscriminator,
  value: TDiscriminator["values"][number],
  node: Node<TDataContent> | Node<TDataContent>[],
): ComputedMemberDef<TDataContent> {
  // A string ref carries no value set at construction; the branch value is
  // validated at evaluation time through the canonical env path instead.
  if (typeof discriminator !== "string") {
    assertBranchValue(discriminator, value);
  }
  return memberSelectComputed(discriminator, true, {
    [value]: Array.isArray(node) ? node : [node],
  });
}

/**
 * The shared lowering behind selectMember/whenMember (also the hydration path
 * for the serialized select wire shape): a computed member whose registry is
 * every branch node, whose compute reads the discriminator through the
 * canonical env path, and whose metadata carries the declarative sugar data.
 * The name is deterministic — pure data (discriminator + branch shape), no
 * randomness — so memo and diff identity are stable across processes.
 */
export function memberSelectComputed<TDataContent>(
  discriminator: AnyDiscriminator | Ref,
  partial: boolean,
  branches: Record<string, Node<TDataContent>[] | null>,
): ComputedMemberDef<TDataContent> {
  const discriminatorName =
    typeof discriminator === "string" ? discriminator : discriminator.name;
  assertProjectorIdentifier(discriminatorName, "Discriminator name");
  const registry: Node<TDataContent>[] = [];
  for (const branch of Object.values(branches)) {
    for (const node of branch ?? []) {
      if (!registry.includes(node)) {
        registry.push(node);
      }
    }
  }
  const name = `memberSelect.${discriminatorName}.${Object.entries(branches)
    .map(([value, branch]) => `${value}=${(branch ?? []).map((node) => node.key).join(",")}`)
    .join(";")}`;
  return {
    kind: "computedMember",
    name,
    ...(registry.length > 0 ? { registry } : {}),
    metadata: { discriminator, partial, branches },
    compute: (env) => branches[env.discriminator(discriminator)] ?? null,
  };
}

/**
 * The shared lowering behind select/when (also the hydration path for the
 * serialized select wire shape) — the parts-side mirror of
 * memberSelectComputed: a computed part whose registry is auto-derived from
 * every branch's inline actions (ref-lookup, validation, and serialized
 * bare-ref recovery walk it), whose compute reads the discriminator through
 * the canonical env path and returns the chosen branch's parts, and whose
 * metadata carries the declarative sugar data. The def is deliberately
 * slot-less: branch parts keep their own slot addresses and unaddressed parts
 * land in the node's default placement, exactly as SelectPart branches did.
 * The name is deterministic — pure data (discriminator + branch shape), no
 * randomness — so memo and diff identity are stable across processes.
 */
export function partSelectComputed<TDataContent>(
  discriminator: AnyDiscriminator | Ref,
  partial: boolean,
  branches: Record<string, Part<TDataContent>[] | null>,
): ComputedPartDef<TDataContent> {
  const discriminatorName =
    typeof discriminator === "string" ? discriminator : discriminator.name;
  assertProjectorIdentifier(discriminatorName, "Discriminator name");
  const registry: AnyAction[] = [];
  const addAction = (action: AnyAction) => {
    if (!registry.includes(action)) {
      registry.push(action);
    }
  };
  for (const branch of Object.values(branches)) {
    for (const part of branch ?? []) {
      if (part.kind === "action") {
        if (typeof part.action !== "string") {
          addAction(part.action);
        }
        continue;
      }
      if (part.kind === "computed") {
        if (typeof part.part === "string") {
          // The sugar's compute closure has no charter access, so a ref could
          // never resolve at evaluation; serialized payloads resolve refs to
          // definitions before hydration reaches this lowering.
          throw new Error(
            `select over "${discriminatorName}" has a branch carrying computed part ref "${part.part}"; branch computeds must be passed by definition`,
          );
        }
        // A nested computed's registry (for sugar, auto-derived from ITS
        // branches) flattens into this registry so its returned actions
        // resolve through the outer def at compile and dispatch. Node entries
        // belong to computed members and are skipped, as in
        // computedRegistryActions.
        for (const entry of (part.part.registry ?? []).filter(
          (candidate): candidate is AnyAction => !isNode(candidate),
        )) {
          addAction(entry);
        }
      }
    }
  }
  const name = `partSelect.${discriminatorName}.${partial ? "partial" : "total"}.${branchesSignature(branches)}`;
  return {
    kind: "computedPart",
    name,
    ...(registry.length > 0 ? { registry } : {}),
    metadata: { discriminator, partial, branches },
    compute: (env) => expandBranchParts(branches[env.discriminator(discriminator)] ?? [], env),
  };
}

/**
 * Lowers a chosen branch's parts into compute-return form. Nested computeds
 * (nested select/when sugar, or a bare computed def placed in a branch) lower
 * at evaluation — their returns splice in, stamped with the inner def's
 * declared slot when a return carries no placement of its own, matching how
 * compile places a directly-contributed computed's returns — so the runtime
 * never sees nesting.
 */
function expandBranchParts<TDataContent>(
  parts: readonly Part<TDataContent>[],
  env: ComputedPartEnv,
): ComputedReturnPart<TDataContent>[] {
  const expanded: ComputedReturnPart<TDataContent>[] = [];
  for (const part of parts) {
    if (part.kind !== "computed") {
      expanded.push(part);
      continue;
    }
    const definition = part.part;
    if (typeof definition === "string") {
      // Unreachable: partSelectComputed rejects refs at construction.
      throw new Error(`Computed part ref "${definition}" cannot evaluate inside a select branch`);
    }
    const placement = slotPlacement(definition.slot);
    for (const item of evaluateComputedPartReturn(definition, env)) {
      if ("kind" in item && item.kind === "action") {
        expanded.push(item);
        continue;
      }
      const content: ContentPart<TDataContent> =
        "kind" in item ? { type: "text", text: item.text, ...slotPlacement(item.slot) } : item;
      const hasOwnPlacement = content.slot !== undefined || content.region !== undefined;
      expanded.push(hasOwnPlacement ? content : { ...content, ...placement });
    }
  }
  return expanded;
}

/**
 * Deterministic identity for a sugar-lowered select: an FNV-1a 64 hash of the
 * branch shape (values, part kinds, placements, texts, action names +
 * descriptions). Parts carry no keys (unlike member nodes), so the hash is
 * the stable stand-in memberSelect gets from node keys — distinct selects at
 * one contributor must get distinct names or the per-compile return memo
 * would conflate them.
 */
function branchesSignature(branches: Record<string, Part<any>[] | null>): string {
  const canonical = Object.entries(branches)
    .map(([value, branch]) => `${value}=${(branch ?? []).map(partSignature).join("+")}`)
    .join(";");
  return fnv1a64(canonical);
}

function partSignature(part: Part<any>): string {
  if (part.kind === "text") {
    return `t|${placementSignature(part.slot)}|${part.text}`;
  }
  if (part.kind === "action") {
    const action = part.action;
    const identity =
      typeof action === "string" ? `ref:${action}` : `${action.name}|${action.description ?? ""}`;
    const guidance = (part.guidance ?? [])
      .map((entry) => `${placementSignature(entry.slot)}|${entry.text}`)
      .join(",");
    return `a|${part.caller}|${part.exposure ?? "native"}|${identity}|${guidance}`;
  }
  return `c|${typeof part.part === "string" ? part.part : part.part.name}`;
}

function placementSignature(slot: Parameters<typeof slotPlacement>[0]): string {
  const placement = slotPlacement(slot);
  if (placement.slot !== undefined) {
    return `slot:${placement.slot}`;
  }
  if (placement.region !== undefined) {
    return `region:${placement.region}`;
  }
  return "";
}

function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function normalizeMemberBranches<TDataContent>(
  branches: Record<string, Node<TDataContent> | Node<TDataContent>[] | null>,
): Record<string, Node<TDataContent>[] | null> {
  const normalized: Record<string, Node<TDataContent>[] | null> = {};
  for (const [value, entry] of Object.entries(branches)) {
    normalized[value] = entry === null ? null : Array.isArray(entry) ? entry : [entry];
  }
  return normalized;
}

function normalizeBranches<TDataContent>(
  branches: Record<string, Part<TDataContent> | Part<TDataContent>[] | null>,
): Record<string, Part<TDataContent>[] | null> {
  const normalized: Record<string, Part<TDataContent>[] | null> = {};
  for (const [value, entry] of Object.entries(branches)) {
    normalized[value] = entry === null ? null : Array.isArray(entry) ? entry : [entry];
  }
  return normalized;
}

function assertBranchValue(discriminator: AnyDiscriminator, value: string): void {
  if (!discriminator.values.includes(value)) {
    throw new Error(
      `Discriminator "${discriminator.name}" has no value "${value}" (values: ${discriminator.values.join(", ")})`,
    );
  }
}

export type DiscriminatorMemo = Map<string, string>;

export function resolveDiscriminatorRef<TDataContent>(
  discriminator: AnyDiscriminator | Ref,
  charter: Charter<TDataContent> | undefined,
): AnyDiscriminator {
  if (typeof discriminator !== "string") {
    return discriminator;
  }
  const resolved = charter?.discriminators[discriminator];
  if (!resolved) {
    throw new Error(`Unknown discriminator ref "${discriminator}"`);
  }
  return resolved;
}
