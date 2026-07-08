import { assertProjectorIdentifier } from "./identifiers.ts";
import type {
  AnyComputedPartDef,
  Charter,
  ComputedPartDef,
  ComputedPartEnv,
  ContentPart,
  Ref,
  SlotAddress,
} from "./types.ts";

export type ComputedPartConfig<TDataContent = never> = {
  name: string;
  slot: SlotAddress;
  compute: (env: ComputedPartEnv) => string | ContentPart<TDataContent>[];
};

/**
 * A named, charter-registered computed contribution: the sanctioned form of
 * dynamism in a node's content. Naming is mandatory — identity is what diffs,
 * memoization, provenance, and serialization key on; the compute function is
 * code and never serializes. Must target a volatile slot (validated at
 * charter build).
 */
export function createComputedPart<TDataContent = never>(
  config: ComputedPartConfig<TDataContent>,
): ComputedPartDef<TDataContent> {
  assertProjectorIdentifier(config.name, "Computed part name");
  return {
    kind: "computedPart",
    name: config.name,
    slot: config.slot,
    compute: config.compute,
  };
}

export function isComputedPartDef(value: unknown): value is AnyComputedPartDef {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "computedPart" &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { compute?: unknown }).compute === "function",
  );
}

export function resolveComputedPartRef<TDataContent>(
  part: ComputedPartDef<TDataContent> | Ref,
  charter: Charter<TDataContent> | undefined,
): AnyComputedPartDef {
  if (typeof part !== "string") {
    return part;
  }
  const resolved = charter?.computedParts[part];
  if (!resolved) {
    throw new Error(`Unknown computed part ref "${part}"`);
  }
  return resolved;
}
