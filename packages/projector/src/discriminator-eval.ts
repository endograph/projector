import { resolveContributorNodeParams, type Contributor } from "./contributors.ts";
import type { DiscriminatorMemo } from "./discriminators.ts";
import type { AnyDiscriminator, StateDescriptor } from "./types.ts";

/**
 * Reads the resolved value of a declared state descriptor at a contributor:
 * nearest container per the descriptor's scope (the hoist rule actions use),
 * falling back to the descriptor's init so the read is total even when no
 * container is in scope.
 */
export function contributorStateValue<TDataContent>(
  contributor: Contributor<TDataContent>,
  descriptor: StateDescriptor,
): { value: unknown; containerInstanceId: string | undefined } {
  const scope = descriptor.scope ?? "hoist";
  const instance = scope === "local"
    ? contributor.concreteInstance
    : contributor.sourceInstance ??
      (contributor.concreteInstance.isSource ? contributor.concreteInstance : undefined);
  const container = instance?.states?.[descriptor.key];
  if (container) {
    return { value: container.value, containerInstanceId: instance?.id };
  }
  const init = descriptor.init;
  return {
    value: typeof init === "function" ? (init as () => unknown)() : init,
    containerInstanceId: undefined,
  };
}

/**
 * Evaluates a discriminator at the selecting contributor. Memoized per compile
 * per resolving container per contributor — the key must include the
 * contributor because derive reads contributor-relative params. Correctness
 * never depends on the memo (derive is pure), so memo-less callers like
 * executeCommand evaluate fresh and agree.
 */
export function evaluateDiscriminator<TDataContent>(
  discriminator: AnyDiscriminator,
  contributor: Contributor<TDataContent>,
  memo?: DiscriminatorMemo,
): string {
  const stateRead = discriminator.state
    ? contributorStateValue(contributor, discriminator.state)
    : { value: undefined, containerInstanceId: undefined };

  const memoKey = `${discriminator.name} ${stateRead.containerInstanceId ?? "init"} ${contributor.id}`;
  const cached = memo?.get(memoKey);
  if (cached !== undefined) {
    return cached;
  }

  const value = discriminator.derive({
    state: stateRead.value,
    params: resolveContributorNodeParams(contributor),
  });
  if (!discriminator.values.includes(value)) {
    throw new Error(
      `Discriminator "${discriminator.name}" derived invalid value "${value}" (values: ${discriminator.values.join(", ")})`,
    );
  }
  memo?.set(memoKey, value);
  return value;
}
