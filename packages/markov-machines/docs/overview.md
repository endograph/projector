# Markov Machines Overview

Markov Machines is a framework for building stateful, multi-node agent workflows. It models an agent as a tree of node instances that can spawn children, delegate work, and coordinate through well-defined orchestration primitives.

## Core Concepts

### Nodes

A **node** is a blueprint for agent behavior at a specific point in a workflow. It defines what the agent knows, what it can do, and where it can go next.

Each node specifies:
- **Instructions** that guide the agent's behavior
- **Tools** the agent can use to take actions
- **Transitions** that allow the agent to move to different nodes
- **Commands** that users can invoke directly (bypassing the agent)
- **State schema** that defines what data this node tracks
- **Packs** that provide shared capabilities across nodes

Nodes come in two varieties:
- **Active nodes** receive user input and can modify shared state
- **Worker nodes** run autonomously in parallel, receive no user input, and must explicitly yield control when done

### Instances

An **instance** is a live, running copy of a node with its own state. While a node is a template, an instance is that template brought to life with actual data.

Instances form a **tree structure**. A root instance can have children, those children can have their own children, and so on. This tree represents the current state of the entire workflow—who's doing what, and how they're organized.

All leaf instances in the tree are **active**—they all execute in parallel during each step. However, at most one leaf can be non-worker (able to receive user input). Worker leaves run autonomously without user input and must explicitly cede when done.

### State

Each instance maintains its own **state**—the data relevant to that particular node's work. State is validated against the node's schema, ensuring type safety throughout the workflow.

State is local to each instance. A search node has search-related state; a checkout node has cart-related state. When transitioning between nodes, state can be carried forward or reset as needed.

### Machines

A **machine** combines everything needed to run an agent session:
- A charter (the static configuration)
- An instance tree (the runtime state)
- Conversation history

Machines are the unit of persistence. Save a machine to pause a conversation; restore it to continue exactly where you left off.

### Charters

A **charter** is the static foundation that machines build upon. It's a registry of all the pieces that make up your application:
- Available nodes
- Global tools and transitions
- Registered packs
- The execution engine

Charters are stateless and shareable. Multiple machines can reference the same charter while maintaining independent state and history.

### Packs

**Packs** are reusable modules that provide shared tools and state across multiple nodes. Think of them as plugins that any node can opt into.

Unlike node state (which is instance-specific), pack state is **singleton-scoped**—one copy shared by all nodes using that pack. An authentication pack could track the current user; a preferences pack could track user settings. Any node that includes these packs sees the same shared state.

Pack tools operate only on pack state, not node state. This separation keeps concerns clean: node tools handle node-specific work; pack tools handle cross-cutting concerns.

### Commands

**Commands** are user-callable methods that bypass agent inference entirely. Instead of asking the agent to do something, the user directly invokes a named operation.

Commands are useful for:
- Administrative actions (approve, reject, cancel)
- Direct state manipulation
- Resuming suspended workflows
- Any operation where you want deterministic behavior rather than agent judgment

Commands can do everything transitions can: return values, change nodes, spawn children, yield control, or suspend execution.

## Orchestration

Nodes don't exist in isolation. They coordinate through four orchestration primitives that control how the instance tree evolves.

### Transition

A **transition** replaces the current node with a different one. The instance stays in the same position in the tree, but its behavior changes completely.

Transitions are the basic building block of workflow progression. A node that gathers requirements transitions to a node that executes the plan. A node handling a question transitions to a specialized node for that question type.

### Spawn

**Spawn** creates child instances beneath the current node. The parent remains in the tree, and new children are added.

Spawning enables delegation and parallelism:
- A coordinator spawns worker nodes to handle subtasks
- A router spawns a specialized handler for a detected intent
- A supervisor spawns multiple worker nodes to work simultaneously

All spawned children become leaves and execute in parallel. At most one can be non-worker (receiving user input); the rest must be worker nodes that work autonomously.

### Cede

**Cede** removes the current instance from the tree and returns control to its parent. It's the inverse of spawn—the child is done, and the parent resumes.

Ceding can pass content back to the parent, allowing children to report results. A search node might cede with its findings; a validation node might cede with approval status.

Worker nodes must always cede when they're done. They can't simply stop—they must explicitly return control.

### Suspend

**Suspend** pauses an instance while keeping it in the tree. The instance becomes dormant, excluded from active execution, until explicitly resumed.

Suspension enables human-in-the-loop workflows:
- Pause for approval before a destructive action
- Wait for external input that can't come from the agent
- Hold state while a human reviews proposed changes

Suspended instances track why they paused and carry metadata about what they're waiting for. Resumption requires matching the suspend ID, preventing accidental or unauthorized continuation.

## Additional Concepts

### Output Mapping

Machines can be parameterized with an **application message type** that defines the structure of messages in conversation history. This allows applications to attach custom metadata, track provenance, or include domain-specific content blocks alongside standard text and tool interactions.

### Node Clients

**Node clients** provide a way to represent nodes in frontend applications. A node's commands, instructions, and state schema can be serialized and sent to a client, which can then render appropriate UI and invoke commands.

The client representation comes in two forms:
- **Dry format**: JSON-serializable data suitable for network transport
- **Hydrated format**: Live objects with callable command functions

This separation allows the same node definitions to power both backend execution and frontend interaction, with commands callable from either side.

## The Big Picture

A Markov Machines application defines nodes (behavior blueprints) and registers them in a charter (the static registry). At runtime, a machine holds an instance tree (live state) rooted in one of those nodes.

As the agent works, it can transition (change behavior), spawn (create children), cede (return to parent), or suspend (pause for humans). The instance tree grows and shrinks, with state flowing through validated schemas and packs providing shared capabilities.

Commands let users intervene directly. Clients let frontends participate. And machines can be serialized and restored, making long-running workflows possible across sessions.
