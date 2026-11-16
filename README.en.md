# pi-magpie-bot

English · **[中文](README.md)**

An always-on personal assistant you run yourself. It remembers things, keeps reminders across
restarts, and talks to you in a browser or on Telegram. It speaks through free models out of the
box: no account, no API key, no bill.

```
You: remind me to turn off the stove in ten minutes
Bot: Right — I'll shout in 10 minutes.

(ten minutes later, even if the machine has restarted)
Bot: Time to turn off the stove.
```

## Why this exists

Products like Grok Bot are good, but your conversations, memories and schedule sit on someone
else's server and you pay monthly for them. This project hands you the same pieces:

- **Free to use.** The free pool comes from [our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)
  through its [magpie plugin](https://github.com/mu-zi-lee/magpie-our-free-model), maintained by the
  community: no account, no key. The first start installs it, signs in and builds the `free`
  routing group; after that nobody touches it. Want more stability or a bigger model? Swap in
  your own — it is one model name.
- **Your data stays yours.** Conversations, memories and schedules are local SQLite and Markdown
  files. Copy the folder and you have migrated.
- **Survives a kill.** A message is written to disk before it is handled; after a restart the work
  carries on, and nothing is answered twice. A message that was cut off mid-answer is closed and
  reported once — it does not come back as a second reply.
- **Nothing touches your machine without a yes.** Let it read your files or run a command and it
  asks first, in the chat, every time.

## Quick start

You need **Node.js 24 or newer** ([download](https://nodejs.org); the built-in database uses the
SQLite it ships). macOS, Linux and Windows under WSL all work.

```sh
pnpm install
pnpm start            # start it
```

The first start is the setup: with no magpie on the machine it downloads the official release
(checksum compared before it is kept), installs the free-model plugin, signs in to the anonymous
pool, creates the `free` routing group, and only then connects. `./install.sh` does the same and
also writes your `.env`.

Then open <http://127.0.0.1:8787> and type.

![Saying "remind me to turn off the stove in ten minutes": the reminder is scheduled, the model is free, no key anywhere](docs/chat.png)

### Does the free pool need configuring?

No. The first start installs the plugin, signs in with its own anonymous account, builds
`group/free`, and only then connects to the gateway — the screenshot above came from exactly that
run, with nobody touching a terminal.

For more quota, or another route while the anonymous pool queues, open the plugin's own console
and attach a channel:

```sh
magpie plugin login our-free-model
```

Stop magpie first: the sign-in asks the running gateway for a management page and is refused.
The terminal prints an address — `127.0.0.1` on your own machine, a temporary `trycloudflare.com`
one on a server (neither needs an account). Open it, follow the page, restart the bot. It works
without this too.

On its first install the plugin fetches its own channel pack from `raw.githubusercontent.com`.
On a network that cannot reach it the free pool does not come up, and both the install script and
the web page say exactly that (`原渠道包下载失败`) instead of pretending it worked — there, use your
own model.

### Telegram

1. Find **@BotFather** in Telegram, `/newbot`, pick a name, keep the token.
2. `./install.sh --telegram` and paste it, or set `TELEGRAM_BOT_TOKEN=` in `.env` yourself.
3. `pnpm start`, then message your bot.

**The first account that talks to it becomes the owner**; anyone else is refused. To let more
people in, add their ids to `ALLOWED_USERS` in `.env`, comma separated.

## Bring your own model

The free pool queues and has limits. For something steady, or a bigger model, there are two ways:

**Your own key** — no terminal needed: when the free pool has nothing to give, the bot puts up a
page saying what is missing, with a vendor dropdown and a key box. Paste the key, press save, and
the same process continues into the chat. To add another later, or from the command line,
`magpie provider add deepseek sk-…` (`magpie presets` lists every vendor), or open `magpie web`
(<http://127.0.0.1:3430>) and add it there.

**A local model** — start Ollama / vLLM / LM Studio on an OpenAI-compatible endpoint, then:

```sh
magpie provider add ollama url=http://127.0.0.1:11434/v1 models=qwen3:8b
```

Set `MAGPIE_MODEL=ollama/qwen3:8b` in `.env` and it is fully offline.

Every step and every trap (which models can call tools, how much context you need) is in
**[docs/own-models.md](docs/own-models.md)**, with an English summary at the end.

## Cloud

```sh
cp .env.example .env        # fill TELEGRAM_BOT_TOKEN and WEB_PASSWORD (a public port needs one)
docker compose up -d        # from the repo root, so .env is found
```

In this mode the bot does not start magpie (`MAGPIE_START=0`), so the free pool is set up once
inside its container:

```sh
docker compose exec magpie \
  /magpie plugin add https://github.com/mu-zi-lee/magpie-our-free-model
docker compose exec -it magpie \
  /magpie plugin login our-free-model          # choose 1, then Ctrl-D to leave
docker compose exec magpie \
  /magpie group add free 'models=our-free-model/*' routing=smart
docker compose restart bot
```

`-it` is required: the menu needs a terminal. The plugin downloads its own Node runtime the first
time, so the container must reach `nodejs.org`; if that fails it says so, and the way around is
your own key below.

The magpie container is a gateway belonging to nobody, so it asks for a key of its own on the
first start (the local one does not): `docker compose exec magpie /magpie gateway-key add bot`,
put the printed `sk-magpie-key-…` into `MAGPIE_API_KEY` in `.env`, then `docker compose up -d`.
Without that the bot's page keeps saying the gateway key was refused.

When no model is ready the bot does not restart in a loop: the web port shows one page saying what
is missing and what to run. The bot in a container only speaks HTTP to the gateway container and
has no magpie of its own, so that page keeps to commands there; run locally it also offers the key
box described above.

Only the web port is exposed; magpie stays on the internal network. To keep the page up, leave
`WEB_HOST=0.0.0.0` to the container and make `WEB_PASSWORD` something you will remember.

> Note: the free pool is limited per egress IP. A cloud server will most likely get nothing from
> it — on a server, bring a key or a local model.

## What it does

| What | How you ask | Under the hood |
| --- | --- | --- |
| Chat | just type | pi-durable sessions |
| Remember | "remember my car is a blue BYD" | Markdown under `memory/`; the index goes in every prompt, the note itself is read on demand |
| Remind | "wake me at seven tomorrow" | a `schedules` table checked every 2 seconds (`TICK_MS`), a due reminder missed while the process was down fires once on the next start |
| Long tasks | it decides | the `send_message` tool speaks first, then works |
| Read files / run commands | set `WORKSPACE_DIR` in `.env` | an approval card in the chat every time; "yes" runs it |
| Web | `pnpm start` | a built-in HTTP server, no external dependency |
| Telegram | a token in `.env` | long polling, no public IP needed |

## Configuration

`.env` (copy from `.env.example`); every line has a default:

| Variable | Default | What it does |
| --- | --- | --- |
| `MAGPIE_MODEL` | `group/free` | which model; the free pool is `group/free` |
| `MAGPIE_BASE_URL` | `http://127.0.0.1:3425` | the gateway |
| `MAGPIE_START` | `1` | `0` connects to an existing magpie instead of starting one (Docker, a remote gateway) |
| `DATA_DIR` | `~/.pi-magpie-bot` | conversations, memory, schedules |
| `TZ` | the system zone | reminders and "what time is it" use it; Docker defaults to `Asia/Shanghai` |
| `WEB_PORT` / `WEB_HOST` | `8787` / `127.0.0.1` | the chat page; `WEB_PORT=0` turns it off |
| `WEB_PASSWORD` | empty | set it and the page asks for it |
| `TELEGRAM_BOT_TOKEN` | empty | set it and Telegram is connected |
| `WORKSPACE_DIR` | empty | only with it can the bot read files and run commands (each one approved) |
| `ALLOWED_USERS` | empty | who else may talk to it, besides the owner |

## How it is built

Standing still for days means standing on library code. This project writes only where nothing
exists:

- **[pi-durable](https://github.com/earendil-works/pi)** — durable runs, crash recovery, retries,
  compaction, signals and sleep. The execution engine is not rewritten here.
- **[magpie](https://github.com/yetone/magpie)** — one gateway speaking the OpenAI, Anthropic and
  Gemini protocols, with routing groups that fail over between models. Changing models needs no
  code change.
- **[our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)** and its
  [magpie plugin](https://github.com/mu-zi-lee/magpie-our-free-model) — the anonymous free pool.
- The thin glue on top — inbox, outbox, schedules, approvals, memory directory, channel adapters —
  is this project's own, about three thousand lines across `packages/*/src`, short enough to read.

```
Telegram / web ──▶ inbox (dedupe, queue) ──▶ pi-durable session ──▶ outbox ──▶ you
                     ▲                            │
                     └────── schedules ───────────┘   (reminders)
```

How state is stored, who does which of the five jobs, and exactly which messages are retried after
a crash: **[docs/architecture.md](docs/architecture.md)**, with an English section at the end.

## Honest limits

- The free pool is **limited per IP**; when it is busy you queue or fail (`Our Free Model: Free
  usage limit reached` is that). `group/free` moves to the next model, but it cannot invent quota.
- When the free pool's sign-in expires or an upstream changes its API, run
  `magpie plugin login our-free-model` again (stop magpie first), or switch to your own model.
- pi-durable is marked *experimental*; its API may change between versions. This project is pinned
  to `1.5.x`.
- One process per data directory (SQLite has a single writer).
- An approval card only takes a short yes/no; anything else you type while a card is open is
  treated as a new message.

## Development

```sh
pnpm install
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest
pnpm smoke         # ask the first model in the gateway one question
pnpm smoke:bot     # run the whole chain without a chat platform
```

Packages: `packages/gateway` (models), `packages/events` (host tables), `packages/memory`
(memory files), `packages/brain` (sessions and tools), `packages/channels/*` (Telegram, web),
`apps/bot` (the entry point).

## License

MIT. Third-party components and attribution: [NOTICE.md](NOTICE.md).
