import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { createCommand, createNode, type StateAddress } from "../../../index.ts";
import {
  consumeCommandResidue,
  createCommandMessage,
  createMachineClientSnapshot,
  createMachineEffigy,
  createMachineSyncState,
  createOptimisticEffigy,
  findClientCommand,
  realizeClientInstances,
  recordCommandResidue,
  type ClientCommandDefinitionInput,
  type ClientCommandName,
  type ClientInstanceOf,
} from "../index.ts";

describe("client command typing and messages", () => {
  it("constructs typed command messages with generated or supplied client IDs", () => {
    const setLiveMode = createCommand({
      state: null,
      name: "setLiveMode",
      inputSchema: z.object({ enabled: z.boolean() }),
    });

    type Input = ClientCommandDefinitionInput<typeof setLiveMode>;
    expectTypeOf<Input>().toEqualTypeOf<{ enabled: boolean }>();

    const message = createCommandMessage<typeof setLiveMode>(
      "setLiveMode",
      { enabled: true },
      {
        clientId: "client-1",
        target: { type: "instance", instanceId: "agent" },
      },
    );

    expect(message).toEqual({
      type: "command",
      name: "setLiveMode",
      input: { enabled: true },
      target: { type: "instance", instanceId: "agent" },
      clientId: "client-1",
    });

    const generated = createCommandMessage<typeof setLiveMode>("setLiveMode", {
      enabled: false,
    });
    expect(generated.clientId).toEqual(expect.any(String));

    if (false) {
      // @ts-expect-error command name must come from the command definition
      createCommandMessage<typeof setLiveMode>("other", { enabled: true });
      // @ts-expect-error command input must come from the command input schema
      createCommandMessage<typeof setLiveMode>("setLiveMode", { enabled: "yes" });
    }
  });
});

describe("machine effigy", () => {
  it("stores subscribed instances, command residue, and sends messages", async () => {
    const sent: unknown[] = [];
    const effigy = createMachineEffigy<{ value: number }>((message) => {
      sent.push(message);
      return "sent";
    });
    let notifications = 0;
    const unsubscribe = effigy.subscribe(() => {
      notifications += 1;
    });

    effigy.setInstances({ value: 1 });
    effigy.setRecentCommandResidue(["a"]);
    unsubscribe();
    effigy.setInstances({ value: 2 });

    await expect(
      effigy.send({ type: "command", name: "save", input: {}, clientId: "c" }),
    ).resolves.toBe("sent");
    expect(effigy.getInstances()).toEqual({ value: 2 });
    expect(effigy.getRecentCommandResidue()).toEqual(["a"]);
    expect(notifications).toBe(2);
    expect(sent).toEqual([{ type: "command", name: "save", input: {}, clientId: "c" }]);
  });
});

describe("client instance realization", () => {
  it("realizes concrete instances, member runtime addresses, state addresses, and command targets", () => {
    const setLiveMode = createCommand({
      state: null,
      name: "setLiveMode",
      inputSchema: z.object({ enabled: z.boolean() }),
    });
    const agentState = {
      key: "agentState",
      schema: z.object({ liveMode: z.boolean() }),
      init: { liveMode: false },
      projection: "hidden" as const,
    };
    const critic = createNode({ key: "critic", commands: [setLiveMode] });
    const child = createNode({ key: "child" });
    const agent = createNode({
      key: "agent",
      state: agentState,
      commands: [setLiveMode],
      members: [critic],
    });

    type AgentClientInstance = ClientInstanceOf<typeof agent>;
    expectTypeOf<ClientCommandName<AgentClientInstance>>().toEqualTypeOf<"setLiveMode">();

    const client = realizeClientInstances({
      id: "agent-1",
      node: agent,
      children: [{ id: "child-1", node: child }],
    });

    expect(client.runtime.runtimeInstanceId).toBe("instance:agent-1");
    expect(client.states[0]).toMatchObject({
      key: "agentState",
      address: { instanceId: "agent-1", stateKey: "agentState" },
      value: { liveMode: false },
    });
    expect(client.commands[0]?.target).toEqual({ type: "instance", instanceId: "agent-1" });
    expect(client.members[0]?.runtime.runtimeInstanceId).toBe("member:agent-1/critic");
    expect(client.members[0]?.commands[0]?.target).toEqual({
      type: "member",
      ownerInstanceId: "agent-1",
      memberPath: ["critic"],
    });
    expect(client?.children[0]?.runtime.runtimeInstanceId).toBe("instance:child-1");

    expect(findClientCommand([client], "setLiveMode")?.target).toEqual({
      type: "member",
      ownerInstanceId: "agent-1",
      memberPath: ["critic"],
    });
    expect(
      findClientCommand([client], "setLiveMode", { type: "instance", instanceId: "agent-1" })
        ?.target,
    ).toEqual({ type: "instance", instanceId: "agent-1" });
  });
});

describe("optimistic effigy", () => {
  it("applies optimistic overlays, rebases on authoritative instances, and retires by residue", async () => {
    type Instances = Array<{
      states: Array<{ address: StateAddress; value: { liveMode: boolean; count: number } }>;
      commands: Array<{ name: "setLiveMode"; __input?: { enabled: boolean } }>;
      members: [];
      children: [];
      runtime: unknown;
    }>;

    const address = { instanceId: "agent-1", stateKey: "agentState" };
    const sent: unknown[] = [];
    const effigy = createMachineEffigy<Instances>((message) => {
      sent.push(message);
    });
    effigy.setInstances([
      {
        states: [{ address, value: { liveMode: false, count: 1 } }],
        commands: [{ name: "setLiveMode" }],
        members: [],
        children: [],
        runtime: {},
      },
    ] as Instances);

    const optimistic = createOptimisticEffigy(effigy);
    let notifications = 0;
    const unsubscribe = optimistic.subscribe(() => {
      notifications += 1;
    });
    const command = optimistic.getCommand("setLiveMode", {
      optimistic: (ctx, input) => {
        ctx.patchAt(address, { liveMode: input.enabled });
      },
    });

    await command.run({ enabled: true });
    expect(notifications).toBeGreaterThan(0);
    expect(optimistic.getInstances()?.[0]?.states[0]?.value).toEqual({
      liveMode: true,
      count: 1,
    });
    unsubscribe();

    effigy.setInstances([
      {
        states: [{ address, value: { liveMode: false, count: 2 } }],
        commands: [{ name: "setLiveMode" }],
        members: [],
        children: [],
        runtime: {},
      },
    ] as Instances);
    expect(optimistic.getInstances()?.[0]?.states[0]?.value).toEqual({
      liveMode: true,
      count: 2,
    });

    const clientId = (sent[0] as { clientId: string }).clientId;
    optimistic.setRecentCommandResidue([clientId]);
    expect(optimistic.getInstances()?.[0]?.states[0]?.value).toEqual({
      liveMode: false,
      count: 2,
    });
  });

  it("keeps later pending overlays when an earlier command is confirmed with a fresh instance", async () => {
    type Instances = Array<{
      states: Array<{ address: StateAddress; value: { count: number } }>;
      commands: Array<{ name: "setCount"; __input?: { count: number } }>;
      members: [];
      children: [];
      runtime: unknown;
    }>;

    const address = { instanceId: "agent-1", stateKey: "agentState" };
    const sent: Array<{ clientId: string }> = [];
    const effigy = createMachineEffigy<Instances>((message) => {
      sent.push(message as { clientId: string });
    });
    effigy.setInstances([
      {
        states: [{ address, value: { count: 0 } }],
        commands: [{ name: "setCount" }],
        members: [],
        children: [],
        runtime: {},
      },
    ] as Instances);

    const optimistic = createOptimisticEffigy(effigy);
    const command = optimistic.getCommand("setCount", {
      optimistic: (ctx, input) => {
        ctx.patchAt(address, { count: input.count });
      },
    });

    await command.run({ count: 1 });
    await command.run({ count: 2 });
    expect(optimistic.getInstances()?.[0]?.states[0]?.value).toEqual({ count: 2 });

    effigy.setRecentCommandResidue([sent[0]!.clientId]);
    effigy.setInstances([
      {
        states: [{ address, value: { count: 1 } }],
        commands: [{ name: "setCount" }],
        members: [],
        children: [],
        runtime: {},
      },
    ] as Instances);

    expect(optimistic.getInstances()?.[0]?.states[0]?.value).toEqual({ count: 2 });
  });

  it("can explicitly clear pending overlays", async () => {
    type Instances = Array<{
      states: Array<{ address: StateAddress; value: { count: number } }>;
      commands: Array<{ name: "setCount"; __input?: { count: number } }>;
      members: [];
      children: [];
      runtime: unknown;
    }>;

    const address = { instanceId: "agent-1", stateKey: "agentState" };
    const effigy = createMachineEffigy<Instances>(() => undefined);
    effigy.setInstances([
      {
        states: [{ address, value: { count: 0 } }],
        commands: [{ name: "setCount" }],
        members: [],
        children: [],
        runtime: {},
      },
    ] as Instances);

    const optimistic = createOptimisticEffigy(effigy);
    const command = optimistic.getCommand("setCount", {
      optimistic: (ctx, input) => {
        ctx.patchAt(address, { count: input.count });
      },
    });

    await command.run({ count: 3 });
    expect(optimistic.getInstances()?.[0]?.states[0]?.value).toEqual({ count: 3 });

    optimistic.clearPending();
    expect(optimistic.getInstances()?.[0]?.states[0]?.value).toEqual({ count: 0 });
  });
});

describe("command residue helpers", () => {
  it("keeps residue as bounded machine-level sync metadata", () => {
    const sync = recordCommandResidue(
      recordCommandResidue(createMachineSyncState(["old"]), "a", { limit: 2 }),
      "b",
      { limit: 2 },
    );
    expect(sync.recentCommandResidue).toEqual(["a", "b"]);

    const consumed = consumeCommandResidue(sync, ["a"]);
    expect(consumed.recentCommandResidue).toEqual(["b"]);

    expect(createMachineClientSnapshot("root", consumed)).toEqual({
      root: "root",
      recentCommandResidue: ["b"],
    });
  });
});
