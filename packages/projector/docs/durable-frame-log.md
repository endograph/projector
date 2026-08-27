# Durable frame log

> Stub — expand as the API settles.

Every meaningful transition in a projector agent is recorded as a frame:
user messages, state updates, tool calls, work scheduling. The log is the
source of truth — app state is a view derived from it.

```
$ projector replay --tail
0041  user.message   "add oat milk to the list"
0042  state.todos    +{ title: "oat milk" }
0043  agent.tool     grocery.search("oat milk")
0044  agent.say      "added — want the barista kind?"
      replayed 44/44 frames · state identical ✓
```

Replay the log and you get the same machine, byte for byte. This is what
makes agents [state complete](./state-complete.md).

## Work scheduling

Scheduled work lives in the log too. Queuing, deferring, and running work
later are frames like any other — so a replay reconstructs not just what
the agent did, but what it still intends to do.
