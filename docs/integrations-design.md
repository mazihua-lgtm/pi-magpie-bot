# Integrations and proactivity design (draft)

Status: design only. Implementation is not in this branch yet.

## Current extension points (from packages/brain/src and packages/events/src)

- Tools: each capability is an `Extension` built with `defineExtension({ name, tools, sections })` from `@earendil-works/pi-durable`. Tools use `defineTool({ name, description, parameters, execute(args, api) })`, with params from `@earendil-works/pi-schema` (`obj`, `str`, `opt`). Results are `{ output: [{ type: 'text', text }], isError? }`. `api.conversationId` identifies the caller. Examples: `memory-extension.ts`, `web-extension.ts`.
- Prompt sections: `section(name, async (input) => string | undefined)` injects context into the system prompt.
- Schedules: `packages/events/src/schedule.ts`. Table `schedules(id, conversation, channel, target, text, next_run_at, every_ms, created_at)`. `add({ conversation, channel, target, text, at, everyMs? })`, `due(now)`, `fired(row)` (advances or drops), `nextAt`, `list`, `remove`. A due row is turned into an inbox event by the bot tick.
- Inbox: `packages/events/src/inbox.ts`. `admit({ source, sourceKey, conversation, text, attachments? })` is deduplicated on `(source, sourceKey)`. `claim`, `finish`, `reclaim`, `count`.
- Outbox: `packages/events/src/outbox.ts` delivers replies to channels by `(channel, target)`.
- Targets: `packages/events/src/targets.ts` binds a conversation to a channel target.

## Proposed design

### 1. Integration registry
A new package `packages/integrations` exposing `createIntegrationExtensions(config)`, returning one Extension per enabled integration. Each integration declares: id, required env vars, tools, optional poller.

### 2. Feishu (Calendar and Tasks)
Tools: `feishu_calendar_list` (agenda for a time range), `feishu_calendar_create` (approval-gated), `feishu_task_list`, `feishu_task_create` (approval-gated). Auth via tenant or user access token from `FEISHU_APP_ID` / `FEISHU_APP_SECRET` (already used by the Feishu channel); user-scoped calendar needs an OAuth user token stored in settings. Writes go through the existing approval mechanism.

### 3. Gmail (Read, Search, and IMAP/API)
Tools: `gmail_search` (query), `gmail_read` (message id), read-only by default. Access via the Gmail REST API with OAuth (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, refresh token) or IMAP with an app password (`GMAIL_IMAP_USER`, `GMAIL_IMAP_APP_PASSWORD`). Sending is out of scope for this phase and would require approval.

### 4. Email monitoring and proactive schedules
A poller runs on the schedules tick (for example every 5 minutes, `everyMs` = 300000). It queries new messages since a stored cursor (Gmail `historyId` or IMAP UID), filters by rules, and when a match is found it calls `Inbox.admit` with a deterministic `sourceKey` (message id) so each email triggers at most once. The conversation then summarizes it to the owner through the normal outbox path. Rules live in a markdown file so the user can edit them.

## Security
- Secrets only from env, never committed. `.env.example` gets placeholders.
- Email bodies are untrusted input: the poller passes them as data, and write tools stay behind approval.
- Read-only Gmail scopes by default.

## Open questions for the owner
1. Which Feishu identity should calendar and task tools act as: the app (tenant) or the user (OAuth)?
2. Gmail: OAuth (more setup, safer) or IMAP app password (simpler)?
3. Poll interval and which mailbox folders to watch.

## Plan
1. Read bot.ts wiring and the Feishu channel code.
2. Implement integrations package and Feishu tools with tests.
3. Implement Gmail tools and the email poller with tests.
4. Add .env.example entries and docs.
