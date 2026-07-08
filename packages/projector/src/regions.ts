import type { LayoutRegionName, RegionAddress } from "./types.ts";

export const layoutRegionNames: readonly LayoutRegionName[] = ["preamble", "recency"];

/** The durable-framing region's default slot in the active layout. */
export const preambleRegion: RegionAddress = { kind: "region", region: "preamble" };

/** The freshness region's default slot in the active layout. */
export const recencyRegion: RegionAddress = { kind: "region", region: "recency" };

const byName: Record<LayoutRegionName, RegionAddress> = {
  preamble: preambleRegion,
  recency: recencyRegion,
};

/** The canonical sentinel for a region name (hydration re-enters by identity). */
export function regionAddress(region: LayoutRegionName): RegionAddress {
  return byName[region];
}

export function isRegionAddress(value: unknown): value is RegionAddress {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "region" &&
      typeof (value as { region?: unknown }).region === "string" &&
      (value as { region: string }).region in byName,
  );
}
