# 它是怎么搭的 / How it is built

一个常驻 Agent 要解决的其实是五件事：外面的事怎么进来、时间到了怎么叫醒自己、记性放哪、动用户的东西谁来点头、话怎么发出去。这个项目只写这五件里没有现成轮子的部分，其余交给 pi-durable 和 magpie。

## 一张图

```
Telegram / 网页 ──▶ inbox ──▶ pi-durable 会话 ──▶ outbox ──▶ 你
                     ▲              │
                     └── schedules ─┘      （定时任务到点写成一条 inbox 事件）
```

数据落三个地方，都在 `DATA_DIR`（默认 `~/.pi-magpie-bot`）里：

```
host.sqlite    inbox / outbox / schedules / approvals / settings / conversations
agent.sqlite   pi-durable 自己的：消息、工具调用、任务进度
memory/        一个事实一个 Markdown 文件（人也能直接看、直接改）
```

## 五件套分别是谁做的

| 要解决的问题 | 用的谁的 | 自己写的 |
| --- | --- | --- |
| 外面的事进来 | pi-durable 的 `submit`：忙时排队、原子接纳、崩溃后续跑 | `inbox` 表：按 `(source, source_key)` 去重；渠道把 update 翻译成事件 |
| 到点叫醒自己 | 每次心跳扫一遍 `schedules`，到点的写成一条 inbox 事件 | 周期日程（每天/每周）就靠这张表，进程重启照样算 |
| 记性 | — | `memory_write` / `memory_read` 工具 + 系统提示里只放索引，正文按需读 |
| 谁点头才能动 | pi-durable 的工具挂起（工具停住等人，答案存盘） | `approvals` 表 + 聊天里的审批卡 + 回答方鉴权（pi-durable 的 signal 不校验发送方） |
| 话发出去 | — | `outbox` 表 + 分发器（重试、`attempts`、`retry_at`），渠道只管把消息送到 |

## 一次对话经过哪些地方

1. 渠道收到消息，生成 `sourceKey`，写 `inbox`（同一条重复投递只留一份）。
2. 主循环（默认 2 秒一跳）取出待处理的事件，交给对应的 pi-durable 会话。
3. 会话调模型。要动文件或执行命令时弹审批卡，工具挂起，等人答「是」。
4. 回答经 `send_message` 或直接回到 `outbox`，由渠道送出去。

## 断电和重复

- 还没轮到的消息（inbox 里 `pending`）：重启后照常处理，一条不少。
- 答到一半被杀的消息（`running`）：不会重答一遍——重答就变成两条回复了。它被关掉，并且告诉你「刚才那条被中断了」。
- 发件箱里状态是 `sending` 却没发完的：重启时不重发（宁可漏一条，不重复打扰）。
- 提醒到点时进程不在：日程还在表里，下次启动扫到过期的一条，补发一次。
- 同一时刻只允许一个进程占用一个 `DATA_DIR`（SQLite 单写者）。

## 换模型不动这里

模型层是 magpie，协议是 OpenAI 兼容。换成自己的模型、加一个厂商 key、建一个路由组，都只是 magpie 那边的事——`packages/gateway` 只会问一句「现在有哪些模型」。

---

## In English

Five things make an always-on agent: getting outside events in, waking itself on time,
remembering, asking before touching the user's machine, and delivering replies. Only the
parts no library does are written here:

- **inbox** — a `(source, source_key)` deduplicated table; channels translate updates into events.
- **schedules** — one table of due times; a tick turns them into inbox events.
- **memory** — Markdown notes plus two tools, with only the index in the system prompt.
- **approvals** — a table, a card in the chat, and an answer that is checked; the parked tool
  resumes from stored state.
- **outbox** — a table with attempts and retry times; channels only deliver.

Run state lives in three places under `DATA_DIR`: `host.sqlite` (the tables above),
`agent.sqlite` (pi-durable's own), and `memory/`. A message that had not been started is
handled after a restart; an answer cut off mid-run is not produced twice — it is closed and
the user is told it was interrupted; a half-sent message is not re-sent; a reminder that came
due while the process was down fires once at the next start.
