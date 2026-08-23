# State complete

> Stub — expand as the API settles.

A projector agent is state complete: everything the agent is can be recovered
from state alone. Frame log + app state + configuration. No hidden prompt
strings, no ambient context living outside the machine.

Because the state is complete, it is:

- **Replayable** — rebuild the agent at any frame and get the same machine.
- **Forkable** — branch from any point and run a variation.
- **Testable** — assert on state, not on transcripts.

## What counts as state

- The durable frame log (see [durable-frame-log.md](./durable-frame-log.md))
- Application state owned by the machine
- Agent configuration, including projections and dimensions

## What doesn't

Anything you can't replay from the log isn't state — it's a leak. If a
behavior depends on it, move it into the machine.
