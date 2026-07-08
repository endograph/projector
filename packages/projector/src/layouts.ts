import { assertProjectorIdentifier } from "./identifiers.ts";
import { createSlot } from "./slots.ts";
import type {
  CompileDiagnostic,
  CompiledPart,
  ContentPart,
  HistoryProjection,
  LayoutDef,
  LayoutRegionName,
  SlotDef,
} from "./types.ts";

/**
 * Stamped as the `slot` of compiled parts that were untagged in a region with
 * no default slot. Contains `:`, which slot-name validation forbids, so it can
 * never collide with a declared slot.
 */
export const UNSLOTTED_PART_SLOT = ":untagged";

export type LayoutConfig = {
  name: string;
  /** Unknown slot names error at compile instead of overflowing. */
  strict?: boolean;
  regions?: Partial<Record<LayoutRegionName, SlotDef[]>>;
  /** How frames render into history for documents using this layout. */
  historyProjection?: HistoryProjection<any>;
  default?: boolean;
};

export type CreatedLayout = LayoutDef & { default?: boolean };

/**
 * A layout owns naming, ordering, and rendering for one compiled document.
 * Regions are a closed set defined by the IR contract (executors lower them):
 * `preamble` (durable framing) and `recency` (attention-adjacent freshness),
 * compiled to the identically named CompiledInference fields. One layout per
 * compiled surface; layouts never merge or cascade.
 */
export function createLayout(config: LayoutConfig): CreatedLayout {
  assertProjectorIdentifier(config.name, "Layout name");
  const regions: Record<LayoutRegionName, SlotDef[]> = {
    preamble: [...(config.regions?.preamble ?? [])],
    recency: [...(config.regions?.recency ?? [])],
  };

  const seen = new Set<string>();
  for (const region of Object.values(regions)) {
    for (const slot of region) {
      if (seen.has(slot.name)) {
        throw new Error(`Duplicate slot "${slot.name}" in layout "${config.name}"`);
      }
      seen.add(slot.name);
    }
  }
  for (const [regionName, slots] of Object.entries(regions)) {
    const defaults = slots.filter((slot) => slot.default);
    if (defaults.length > 1) {
      throw new Error(
        `Layout "${config.name}" region "${regionName}" declares ${defaults.length} default slots; at most one is allowed`,
      );
    }
  }

  return {
    kind: "layout",
    name: config.name,
    strict: config.strict ?? false,
    regions,
    ...(config.historyProjection ? { historyProjection: config.historyProjection } : {}),
    ...(config.default ? { default: true } : {}),
  };
}

export function isLayoutDef(value: unknown): value is LayoutDef {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "layout" &&
      typeof (value as { name?: unknown }).name === "string",
  );
}

/**
 * The layout used when a charter registers none: one untitled default slot
 * per region, so rendering reduces to arrival order.
 */
export const implicitDefaultLayout: LayoutDef = createLayout({
  name: "implicitDefaultLayout",
  regions: {
    preamble: [createSlot("body", { default: true })],
    recency: [createSlot("context", { default: true, volatile: true })],
  },
});

/** Warns when a stable slot is ordered after a volatile one within a region. */
export function lintLayoutVolatileOrder(layout: LayoutDef): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const [regionName, slots] of Object.entries(layout.regions)) {
    let volatileSeen: string | undefined;
    for (const slot of slots) {
      if (slot.volatile) {
        volatileSeen = slot.name;
      } else if (volatileSeen) {
        diagnostics.push({
          severity: "warning",
          code: "volatile-order",
          message: `Layout "${layout.name}" region "${regionName}" orders stable slot "${slot.name}" after volatile slot "${volatileSeen}"; this forfeits prompt-cache prefix stability`,
        });
      }
    }
  }
  return diagnostics;
}

export function layoutRegionForSlot(
  layout: LayoutDef,
  slot: string,
): LayoutRegionName | undefined {
  for (const [regionName, slots] of Object.entries(layout.regions) as Array<
    [LayoutRegionName, SlotDef[]]
  >) {
    if (slots.some((candidate) => candidate.name === slot)) {
      return regionName;
    }
  }
  return undefined;
}

export function layoutSlot(layout: LayoutDef, slot: string): SlotDef | undefined {
  for (const slots of Object.values(layout.regions)) {
    const found = slots.find((candidate) => candidate.name === slot);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export function defaultSlotForRegion(
  layout: LayoutDef,
  region: LayoutRegionName,
): SlotDef | undefined {
  return layout.regions[region].find((slot) => slot.default);
}

/**
 * Renders one region's parts per the layout: group by slot tag (untagged and
 * region-addressed → the region's default slot), emit slot buckets in
 * declared order, render
 * titles and merge modes, cohere unknown slots as pseudo-slots at the region
 * tail (ordered by name), and stamp each output part with its resolved slot
 * identity and volatility. Text runs within a slot merge per the slot's merge
 * mode; image/data parts pass through in position.
 */
export function renderRegion<TDataContent>(
  parts: ContentPart<TDataContent>[],
  layout: LayoutDef,
  region: LayoutRegionName,
  onDiagnostic: (diagnostic: CompileDiagnostic) => void,
): CompiledPart<TDataContent>[] {
  const slots = layout.regions[region];
  const defaultSlot = defaultSlotForRegion(layout, region);
  const declared = new Set(slots.map((slot) => slot.name));

  const buckets = new Map<string, ContentPart<TDataContent>[]>();
  const unknownOrder: string[] = [];
  for (const part of parts) {
    const slot = part.slot ?? defaultSlot?.name;
    const bucketKey = slot ?? "";
    if (slot !== undefined && !declared.has(slot) && !unknownOrder.includes(slot)) {
      unknownOrder.push(slot);
      const message = `Unknown slot "${slot}" in region "${region}" of layout "${layout.name}"; rendered at the region tail`;
      if (layout.strict) {
        throw new Error(message);
      }
      onDiagnostic({ severity: "warning", code: "unknown-slot", message });
    }
    const bucket = buckets.get(bucketKey) ?? [];
    bucket.push(part);
    buckets.set(bucketKey, bucket);
  }

  const rendered: CompiledPart<TDataContent>[] = [];
  const emitBucket = (slot: SlotDef, bucket: ContentPart<TDataContent>[] | undefined) => {
    if (!bucket || bucket.length === 0) {
      return;
    }
    rendered.push(...renderSlotBucket(slot, bucket));
  };

  // Untagged parts were bucketed under the default slot's name (or "" when
  // the region declares no default slot), so declared slots emit directly.
  for (const slot of slots) {
    emitBucket(slot, buckets.get(slot.name));
  }
  // Region with no default slot: untagged parts render at the tail, bare
  // (unmerged, untitled) but stamped; they never extend the stable prefix.
  const untargeted = buckets.get("");
  if (untargeted) {
    rendered.push(...untargeted.map((part) => stampPart(part, UNSLOTTED_PART_SLOT, true)));
  }
  // Unknown slots: pseudo-slots at the region tail, deterministic by name.
  // Constructed inline (not via createSlot) so data-loaded slot names that
  // fail identifier validation still degrade gracefully instead of throwing.
  // Volatile: they render after any declared volatile slots, so stamping them
  // stable would break the stable-before-volatile compiled ordering.
  for (const slot of [...unknownOrder].sort()) {
    emitBucket(
      { kind: "slot", name: slot, merge: "block", volatile: true, default: false },
      buckets.get(slot),
    );
  }

  return rendered;
}

function renderSlotBucket<TDataContent>(
  slot: SlotDef,
  bucket: ContentPart<TDataContent>[],
): CompiledPart<TDataContent>[] {
  const out: CompiledPart<TDataContent>[] = [];
  if (slot.title) {
    out.push({ type: "text", text: `${slot.title}:`, slot: slot.name, volatile: slot.volatile });
  }

  let textRun: string[] = [];
  const flushRun = () => {
    if (textRun.length === 0) {
      return;
    }
    const text = slot.merge === "list"
      ? textRun.map((entry) => `- ${entry}`).join("\n")
      : textRun.join("\n\n");
    out.push({ type: "text", text, slot: slot.name, volatile: slot.volatile });
    textRun = [];
  };

  for (const part of bucket) {
    if (part.type === "text") {
      textRun.push(part.text);
      continue;
    }
    flushRun();
    out.push(stampPart(part, slot.name, slot.volatile));
  }
  flushRun();
  return out;
}

/** Replaces draft placement (slot/region/partDepth) with the compiled stamp. */
function stampPart<TDataContent>(
  part: ContentPart<TDataContent>,
  slot: string,
  volatile: boolean,
): CompiledPart<TDataContent> {
  const { slot: _slot, region: _region, partDepth: _partDepth, ...rest } = part;
  return { ...rest, slot, volatile } as CompiledPart<TDataContent>;
}
