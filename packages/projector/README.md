# projector

Projector is an agent framework for building state-complete agents.

Agents are multiplayer apps: the user and the LLM are the first two actors. Projector gives them one shared model of the world, backed by a durable frame log and rendered through projections.

All you need is state.

## Shape

- State complete: the agent is described by recoverable application state.
- Durable frame log: every meaningful transition can be replayed.
- Projection based: each actor sees the slice of state, tools, and instructions meant for them.
- Client/server unified: client and server respresentations are typesafe representations of the same machine.

This package is pre-release. Expect sharp edges and fast iteration.
