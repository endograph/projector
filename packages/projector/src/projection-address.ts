import { assertProjectorIdentifier, assertProjectorIdentifiers } from "./identifiers.ts";
import type { ContributorId, GeneratorId, ProjectionAddress } from "./types.ts";

export const ROOT_INSTANCE_ID = "root";
export const ROOT_GENERATOR_ID = encodeProjectionAddress({
  type: "instance",
  instanceId: ROOT_INSTANCE_ID,
}) as GeneratorId;

export const ROOT_CONTRIBUTOR_ID: ContributorId = ROOT_GENERATOR_ID;

export function encodeProjectionAddress(address: ProjectionAddress): ContributorId {
  if (address.type === "instance") {
    assertProjectorIdentifier(address.instanceId, "Instance id");
    return `instance:${address.instanceId}`;
  }

  assertProjectorIdentifier(address.ownerInstanceId, "Owner instance id");
  assertProjectorIdentifiers(address.memberPath, "Member path");
  return `member:${address.ownerInstanceId}/${address.memberPath.join("/")}`;
}

export function decodeContributorId(encoded: ContributorId): ProjectionAddress {
  if (encoded.startsWith("instance:")) {
    const instanceId = encoded.slice("instance:".length);
    assertProjectorIdentifier(instanceId, "Instance id");
    return { type: "instance", instanceId };
  }

  if (encoded.startsWith("member:")) {
    const rest = encoded.slice("member:".length);
    const [ownerInstanceId, ...memberPath] = rest.split("/");
    if (!ownerInstanceId || memberPath.length === 0) {
      throw new Error(`Malformed contributor id "${encoded}"`);
    }
    assertProjectorIdentifier(ownerInstanceId, "Owner instance id");
    assertProjectorIdentifiers(memberPath, "Member path");
    return { type: "member", ownerInstanceId, memberPath };
  }

  throw new Error(`Malformed contributor id "${encoded}"`);
}
