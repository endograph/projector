import { assertProjectorIdentifier } from "./identifiers.ts";
import { isRegionAddress, layoutRegionNames } from "./regions.ts";
import type { PartPlacement, SlotAddress, SlotDef } from "./types.ts";

export type SlotOptions = {
  title?: string;
  merge?: "block" | "list";
  volatile?: boolean;
  default?: boolean;
};

/**
 * Declares a slot: a named location in the layout that parts address. Slots
 * are first-class shared definitions (like state descriptors and actions) so
 * parts can reference them by identity with type safety; bare string slot
 * names remain the tolerated "proposal tier" for novel or data-loaded parts.
 */
export function createSlot(name: string, options: SlotOptions = {}): SlotDef {
  assertProjectorIdentifier(name, "Slot name");
  if ((layoutRegionNames as readonly string[]).includes(name)) {
    throw new Error(`Slot name "${name}" is reserved: it names a layout region`);
  }
  return {
    kind: "slot",
    name,
    title: options.title,
    merge: options.merge ?? "block",
    volatile: options.volatile ?? false,
    default: options.default ?? false,
  };
}

export function isSlotDef(value: unknown): value is SlotDef {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "slot" &&
      typeof (value as { name?: unknown }).name === "string",
  );
}

export function slotName(slot: SlotAddress | undefined): string | undefined {
  if (slot === undefined || isRegionAddress(slot)) {
    return undefined;
  }
  return typeof slot === "string" ? slot : slot.name;
}

/**
 * Resolves a slot address into the placement tag a projection part carries:
 * slot addresses tag `slot`, region addresses tag `region` (resolved to the
 * region's default slot at render), absent tags nothing (preamble default).
 */
export function slotPlacement(
  slot: SlotAddress | undefined,
): Pick<PartPlacement, "slot" | "region"> {
  if (slot === undefined) {
    return {};
  }
  if (isRegionAddress(slot)) {
    return { region: slot.region };
  }
  return { slot: typeof slot === "string" ? slot : slot.name };
}
