# Third-party notices

This project bundles no third-party source. It depends on, and at run time
talks to, the following MIT-licensed projects. Their licenses and copyright
notices are carried by their own distributions.

## @earendil-works/pi-ai, pi-agent-core, pi-durable, pi-chord

- Source: https://github.com/earendil-works/pi (formerly badlogic/pi-mono)
- License: MIT
- Used for: the model API, the durable agent runtime (conversations, tasks,
  durable sleeps, signals), and the context/document layer.

## magpie

- Source: https://github.com/yetone/magpie
- License: MIT
- Used for: the local gateway that every model request goes through. This
  project downloads magpie's signed release and runs it as a separate
  process; it is not modified or redistributed here.

## Our Free Model (magpie plugin)

- Source: https://github.com/mu-zi-lee/magpie-our-free-model (a third-party
  magpie adaptation of https://github.com/Ebony-Vinyl/dsh-our-free-model)
- License: MIT
- Used for: the optional free-model pool. Installed as a magpie plugin by the
  user, never vendored into this repository.

## @larksuiteoapi/node-sdk

- Source: https://github.com/larksuite/node-sdk
- License: MIT
- Used for: the Feishu / Lark channel (long-connection events and sending
  messages). Installed from npm, not vendored.

## Design references (no code taken)

- https://github.com/NousResearch/hermes-agent (MIT)
- https://github.com/HKUDS/nanobot (MIT)
- Anthropic, "Building always-on agents"
  https://claude.com/resources/articles/building-always-on-agents
