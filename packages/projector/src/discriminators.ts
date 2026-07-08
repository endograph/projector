import { assertProjectorIdentifier } from "./identifiers.ts";
import type {
  AnyDiscriminator,
  Charter,
  Discriminator,
  DiscriminatorEnv,
  MemberEntry,
  MemberSelect,
  Node,
  Part,
  Ref,
  SelectPart,
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
 * union). Branch entries are parts; null contributes nothing.
 */
export function select<
  TDataContent = never,
  TDiscriminator extends AnyDiscriminator = AnyDiscriminator,
>(
  discriminator: TDiscriminator,
  branches: SelectBranches<TDiscriminator, Part<TDataContent>>,
): SelectPart<TDataContent> {
  return {
    kind: "select",
    discriminator,
    partial: false,
    branches: normalizeBranches(branches as Record<string, Part<TDataContent> | Part<TDataContent>[] | null>),
  };
}

/** Partial form of select: contributes the entry only for the given value. */
export function when<
  TDataContent = never,
  TDiscriminator extends AnyDiscriminator = AnyDiscriminator,
>(
  discriminator: TDiscriminator,
  value: TDiscriminator["values"][number],
  entry: Part<TDataContent> | Part<TDataContent>[],
): SelectPart<TDataContent> {
  assertBranchValue(discriminator, value);
  return {
    kind: "select",
    discriminator,
    partial: true,
    branches: { [value]: Array.isArray(entry) ? entry : [entry] },
  };
}

/** Exhaustive member variation: which node(s) are derived per value. */
export function selectMember<
  TDataContent = never,
  TDiscriminator extends AnyDiscriminator = AnyDiscriminator,
>(
  discriminator: TDiscriminator,
  branches: TDiscriminator extends Discriminator<infer TValue>
    ? Record<TValue, Node<TDataContent> | Node<TDataContent>[] | null>
    : never,
): MemberSelect<TDataContent> {
  return {
    kind: "memberSelect",
    discriminator,
    partial: false,
    branches: normalizeMemberBranches(
      branches as Record<string, Node<TDataContent> | Node<TDataContent>[] | null>,
    ),
  };
}

/** Partial member variation: the node(s) are members only for the given value. */
export function whenMember<
  TDataContent = never,
  TDiscriminator extends AnyDiscriminator = AnyDiscriminator,
>(
  discriminator: TDiscriminator,
  value: TDiscriminator["values"][number],
  node: Node<TDataContent> | Node<TDataContent>[],
): MemberSelect<TDataContent> {
  assertBranchValue(discriminator, value);
  return {
    kind: "memberSelect",
    discriminator,
    partial: true,
    branches: { [value]: Array.isArray(node) ? node : [node] },
  };
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

export function isMemberSelect<TDataContent = never>(
  entry: MemberEntry<TDataContent>,
): entry is MemberSelect<TDataContent> {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { kind?: unknown }).kind === "memberSelect"
  );
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
