# 原生 App 接口 / Native app API

The Android app (`android/`) is a native Jetpack Compose client. In local mode it talks to the
bot process on the same phone over `http://127.0.0.1:8787`; after pairing it talks to a bot on
another machine over that machine's address. Both are served by the web channel
(`packages/channels/web`). The old HTML page and its `/api/message` + `/api/events` stay as
they are for browsers; everything below is additive.

Every request carries `Cookie: sid=<uuid>`. When the server has `WEB_PASSWORD` set, a paired
phone also sends `auth=<hmac>` in the same cookie header; see Pairing below. The app makes its
sid once and keeps it, so one phone is one owner; the server takes a sid it has never seen from
the first request on.
A sid is 8 to 64 of `A-Z a-z 0-9 - _` (a UUID is fine); anything else gets 400. All bodies are
JSON, and every POST, PUT and PATCH says `Content-Type: application/json` even when it has no
body (send `{}`): without it the answer is 415, which is what keeps a foreign web page from
posting here. Times are epoch milliseconds. Errors are
`{ "error": "<human readable, Chinese first>" }` with a 4xx/5xx: 400 a bad field, 404 no such
chat / reminder / note / approval (also another phone's), 409 an approval already decided,
413 a body too large, 415 not JSON, 501 a key cannot be added on this machine.

Android's `HttpURLConnection` cannot send PATCH: everywhere this page says PATCH, a POST with
the header `X-HTTP-Method-Override: PATCH` is taken as the same request.

## Chats

A chat is one conversation. Its channel target is `<sid>/<chatId>`; the legacy page's
conversation (target `<sid>`) shows up as a chat with id `default`.

```
Chat = { id, title, createdAt, updatedAt, pinned: bool, model: string|null, thinking: bool, busy: bool }
Message = { id, role: "user"|"assistant", text, thinking?: string, images?: string[] /* data: URIs */,
            tools?: [{ name, label }], at?: number }
```

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| GET | `/api/chats` | | `{ chats: Chat[] }` pinned first, then `updatedAt` desc |
| POST | `/api/chats` | `{ title? }` | `{ chat }` |
| PATCH | `/api/chats/:id` | `{ title?, pinned?, model?, thinking? }` | `{ chat }` |
| DELETE | `/api/chats/:id` | | `{ ok: true }` (also drops its reminders) |
| GET | `/api/chats/:id/messages` | | `{ messages: Message[], busy, partial?: Partial }` |
| POST | `/api/chats/:id/messages` | `{ text, images?: [{ data /* base64 */, mimeType }] }` | 202 `{ chat }` |
| POST | `/api/chats/:id/stop` | | `{ ok: true }` |

`POST /api/chats/new/messages` creates the chat and answers with it, so the first message of a
new chat is one request. Bodies up to 20 MB on the message route (images); 64 KB elsewhere.
A chat's title starts as its first message cut to 24 characters and is replaced by a short
model-written title after the first answer (a `chat` event says so). A title set with PATCH
is never replaced.

A message needs `text` or at least one image. Images: at most 6, `mimeType` one of
`image/png`, `image/jpeg`, `image/webp`, `image/gif`; `data` is base64, or a whole
`data:<type>;base64,…` URI (then `mimeType` may be left out). A chat whose model has no
`vision` refuses images with 400 before anything is sent.

In `messages`, one answer is one assistant message however many tool rounds it took: its
words, its `thinking` and the `tools` it used, folded together. A reminder that fired shows as
an assistant message `⏰ <text>`. Tool results and system notes are left out. `partial` is
there only while `busy`.

`model` null means the default model, and a chat on the default follows it when it changes;
any other value must be an id from `/api/models`. `thinking` on asks the model to reason
(only when the model has `reasoning`; otherwise it is off). Stop drops the messages still
waiting in that chat too, and sends no "no answer" notice.

`DELETE` also works on `default`; its conversation is then gone, and the next message to it
starts a new one.

## Live events

`GET /api/events?v=2` is an SSE stream for the whole owner (every chat). Named events:

| event | data |
| --- | --- |
| `message` | `{ chat, text }` a finished line from the assistant: an answer, a reminder, a notice |
| `partial` | `{ chat, text, thinking, tools: [{ name, label, done: bool }] }` the answer being written, sent as it grows (about 10 times a second at most) |
| `status` | `{ chat, busy: bool }` |
| `approval` | `{ chat, id, action, expiresAt }` the assistant waits for a yes or no |
| `approval_done` | `{ chat, id, status: "allowed"|"denied"|"expired" }` |
| `chat` | `Chat` created, renamed, or its model changed |

On connect the stream first replays what arrived while no app stream was open and the
transcript does not hold (reminders, notices, `send_message` lines, as `message`), once; then
an `approval` for every card still waiting. Answers are not replayed: they are in `messages`.
An approval card's words never come as a `message` here; the `approval` event is the card.
`status` `busy:false` can arrive just before the answer's `message`.

Without `?v=2` the stream is the old one (unnamed `data: {text}` lines), unchanged; it carries
the finished lines of every chat of the owner, approval cards as words included.

## Approvals

| POST | `/api/approvals/:id` | `{ allow: bool }` | `{ ok: true }` |

`approval_done` follows within about a second, whichever way the card ended (this route, a
typed 是/否, the five minutes running out, the run stopped).

## Models

| GET | `/api/models` | | `{ models: [{ id, name, reasoning: bool, vision: bool }], default }` |
| PUT | `/api/settings/model` | `{ model }` | `{ ok: true }` new chats use it |

## Reminders (tasks)

```
Schedule = { id, chat, text, nextRunAt, everyMs: number|null }
```

| GET | `/api/schedules` | | `{ schedules: Schedule[] }` every chat of this owner, soonest first |
| POST | `/api/schedules` | `{ chat, text, at, everyMs? }` | `{ schedule }` |
| DELETE | `/api/schedules/:id` | | `{ ok: true }` |

`at` must be in the future; `everyMs` is null/absent (once) or between 60000 and a year.

## Memory

Memory belongs to the owner, not to one chat: every chat of a phone reads and writes the same
notes.

| GET | `/api/memory` | | `{ notes: [{ name, content }] }` |
| PUT | `/api/memory/:name` | `{ content }` | `{ ok: true }` |
| DELETE | `/api/memory/:name` | | `{ ok: true }` |

`:name` is URL-encoded. It is stored as a slug (lower case, letters, digits, CJK, `-`, `_`),
so `GET` lists it under that slug. The notes an older version kept for the phone's first
conversation become the owner's on first use.

## Model providers

| GET | `/api/providers` | | `{ vendors: [{ preset, name, signupUrl }] }` |
| POST | `/api/providers` | `{ preset, key }`, or `{ custom: { name, url, models, key } }` | `{ ok: true, note }` then the process restarts to load the new models (the Android service brings it back in seconds) |

`signupUrl` may be null. `preset` is one of magpie's own ids (`magpie presets`), written as a
lowercase word. `GET` lists what the first run offers, but a preset that list leaves out is
accepted too - magpie is what finally decides whether it knows the vendor.

`custom` is a vendor magpie has no preset for: an OpenAI-compatible endpoint the user runs or
subscribes to. `url` must be http(s), `models` is a comma- or space-separated list of at most
eight model names, `name` is what the app shows, and a `key`. magpie requires a key on every custom
vendor it files, so an endpoint that needs none must be given a one-word placeholder - which is then
sent as a Bearer token, so a public endpoint that rejects a bogus key will refuse. Nothing checks that
the endpoint answers; magpie's own refusal is what the user is told.

The process exits with code 0 right after the answer is sent; expect the connection to drop and
`/healthz` to fail for a few seconds. Where this machine cannot add keys (the gateway runs
elsewhere, or the page is reachable from other machines without a password) the answer is 501.
`POST /api/setup/key` takes the same two shapes for the case where there is no model at all.

## Pairing (phone to a remote assistant)

The phone can connect to a bot on another machine instead of running one locally. The QR never
carries the password: it carries a one-time code made by someone already logged in.

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| POST | `/api/pair` | logged-in cookie | `{ code, link, address, expiresAt }`; code is 6 chars, 5-minute life |
| GET | `/api/pair/qr?code=<code>` | logged-in cookie | PNG of the link; `image/png` |
| POST | `/api/pair/exchange` `{ code }` | any valid `sid` | `Set-Cookie: auth=<hmac(sid)>`, `{ ok: true }` |

The flow: a browser logged into the computer's page calls `/api/pair`, shows the QR; the phone
scans `http://<address>:<port>/pair/<code>`, then POSTs that code to `/api/pair/exchange` with
**its own** sid. The returned `auth` is an HMAC of that sid with the server's persisted cookie
secret, exactly as `/api/login` would issue — so the phone's auth is bound to the phone's sid,
not the owner's. Every later request sends `Cookie: sid=<phone>; auth=<hmac>`. The code is
destroyed on first use, expires in five minutes, and all pending codes die on a server restart
(they are memory-only). Failed exchanges are rate-limited like password guesses.

`address` comes from `PAIR_HOST` when set, otherwise the first non-loopback private IPv4; if
there is none, `/api/pair` answers 400 and says to set `PAIR_HOST`. Plain HTTP is intended for
a home LAN; put HTTPS in front of the assistant for anything else and scan an https link.

## Setup mode

When there is no usable model, `/healthz` answers `{ ok: false, reason: "no model" }` and only
the setup routes exist (`POST /api/setup/key`, see `setup.ts`). The app shows its own key
screen then.
