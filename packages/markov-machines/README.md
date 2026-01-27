# markov-machines

A small framework for building stateful, multi-node agent workflows. It models an agent as a tree of node instances, supports tool execution and transitions, and persists state/history for long-running sessions.

## Core concepts

- Charter: static registry for nodes, transitions, tools, packs, and the executor.
- Node: instructions, tools, transitions, and a Zod validator for state.
- Instance: runtime node + state (and optional child instances).
- Machine: charter + root instance + conversation history.

## Execution model

`runMachine` performs a single tool-aware inference loop and yields a `MachineStep` for every API call. It keeps executing until the model ends the turn, or a step limit is reached.

Transitions can:
- transition: replace the current node with another.
- spawn: add child node instances; all leaves execute in parallel.
- cede: remove the current instance and return control to the parent.

## Packs

Packs are reusable modules with their own state and tools. Pack state is stored on the root instance and shared across all nodes that include the pack. Pack tools only receive pack state, not node state.

## Serialization

`serializeMachine` and `deserializeMachine` allow persistence of the instance tree and history. Code transitions and inline nodes must be registered in the charter for ref-based serialization.

## Usage example

```ts
import { z } from "zod";
import {
  createCharter,
  createMachine,
  createNode,
  createInstance,
  createStandardExecutor,
  runMachineToCompletion,
  transitionTo,
} from "markov-machines";

const idleNode = createNode({
  instructions: "You are a helpful assistant.",
  validator: z.object({ count: z.number() }),
  tools: {},
  transitions: {},
  initialState: { count: 0 },
});

const charter = createCharter({
  name: "demo",
  executor: createStandardExecutor({ apiKey: process.env.ANTHROPIC_API_KEY }),
  nodes: { idle: idleNode },
});

const rootInstance = createInstance(idleNode, { count: 0 });
const machine = createMachine(charter, { instance: rootInstance });

const step = await runMachineToCompletion(machine, "Hello!");
console.log(step.response);
```

## Exports

Public APIs are exported from `packages/markov-machines/index.ts` including:
- `createCharter`, `createNode`, `createMachine`, `runMachine`, `runMachineToCompletion`
- Transition helpers: `createTransition`, `transitionTo`, `createHelpers`
- Serialization helpers: `serializeMachine`, `deserializeMachine`, etc.
- Types for nodes, instances, transitions, tools, messages, and packs

## Decisions to Revisit

- Sending user input to worker nodes, and otherwise controlling the message history worker nodes have access to
- Should worker nodes be allowed to end_turn? What controls do we need to encourage them to conclude their work correctly? Auto-cede?
- Allowing packs to be provided at any level of the instance tree (maybe packBoundary option?)
- Allowing non-current node tools to operate on their respective tool owner's state. Or is this an anti-pattern and should rely on packs instead of inherited tools?
- State patch semantics: currently `updateState` and helpers use a shallow merge (nested objects are replaced). Revisit whether deep merge is the right default and/or add an opt-in deep merge helper.
- Consider merging system and command message roles into a single "immediate" event role. The role distinction may not be about message type but rather precedence in handling.
- Should commands execute outside of the step loop, and trust that any effects they generate are enqueue'd for the next step run?