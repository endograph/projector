import type { RuntimeAddress } from "./types.ts";

export const SYNTHETIC_ROOT_RUNTIME_ID = "synthetic-root";

export function encodeRuntimeAddress(address: RuntimeAddress): string {
  if (address.type === "instance") {
    return `instance:${address.instanceId}`;
  }

  return `member:${address.ownerInstanceId}/${address.memberPath.map(encodeURIComponent).join("/")}`;
}

export function decodeRuntimeAddress(encoded: string): RuntimeAddress {
  if (encoded.startsWith("instance:")) {
    return { type: "instance", instanceId: encoded.slice("instance:".length) };
  }

  if (encoded.startsWith("member:")) {
    const rest = encoded.slice("member:".length);
    const [ownerInstanceId, ...memberPath] = rest.split("/");
    if (!ownerInstanceId || memberPath.length === 0) {
      throw new Error(`Malformed member runtime address "${encoded}"`);
    }
    return {
      type: "member",
      ownerInstanceId,
      memberPath: memberPath.map(decodeURIComponent),
    };
  }

  throw new Error(`Malformed runtime address "${encoded}"`);
}
