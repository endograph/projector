"use node";

import { action } from "./_generated/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  createInstance,
  serializeInstance,
  type Instance,
  type Node,
} from "markov-machines";
import { nameGateNode, fooNode } from "../../../apps/demo-agent/src/agent/nodes.js";
import { createDemoCharter } from "../../../apps/demo-agent/src/agent/charter.js";
import { serializeInstanceForDisplay } from "markov-machines";

// Charter for serialization only — executor is unused
const demoCharter = createDemoCharter({ executor: { run: async () => ({ response: [] }) } as any });

function initPackStates(node: Node<unknown>): Record<string, unknown> {
  const packStates: Record<string, unknown> = {};
  for (const pack of node.packs ?? []) {
    if (pack.initialState !== undefined) {
      packStates[pack.name] = pack.initialState;
    }
  }
  return packStates;
}

export const createSession = action({
  args: {},
  handler: async (ctx): Promise<Id<"sessions">> => {
    const packStates = initPackStates(nameGateNode as Node<unknown>);
    const instance: Instance = createInstance(nameGateNode as Node<unknown>, {}, undefined, packStates);

    const serializedInstance = serializeInstance(instance, demoCharter);
    const displayInstance = serializeInstanceForDisplay(instance, demoCharter);

    const sessionId = await ctx.runMutation(api.sessions.create, {
      instanceId: instance.id,
      instance: serializedInstance,
      displayInstance,
    });

    return sessionId;
  },
});

export const createSessionAtFoo = action({
  args: {},
  handler: async (ctx): Promise<Id<"sessions">> => {
    const packStates = initPackStates(fooNode as Node<unknown>);
    const instance: Instance = createInstance(
      fooNode as Node<unknown>,
      { name: "Foo" },
      undefined,
      packStates
    );

    const serializedInstance = serializeInstance(instance, demoCharter);
    const displayInstance = serializeInstanceForDisplay(instance, demoCharter);

    const sessionId = await ctx.runMutation(api.sessions.create, {
      instanceId: instance.id,
      instance: serializedInstance,
      displayInstance,
    });

    return sessionId;
  },
});
