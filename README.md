# pi-magpie-bot

一个一直在线、会记事、会提醒你的私人助理。跑在你自己的电脑或服务器上，用免费模型就能开口说话，不需要任何账号和 API key。

An always-on personal assistant you run yourself. Memory, reminders and a chat window on any of your devices. It talks to free models out of the box — no account, no API key, no bill.

```
你：十分钟后提醒我关火
助理：好，10 分钟后我叫你。

（10 分钟后，即使电脑刚重启过）
助理：该关火啦。
```

## 为什么做这个 / Why this exists

Grok Bot 这类产品好用，但你的对话、记忆、日程都在别人服务器上，还要按月付费。这个项目把同样的东西拆开给你：

- **不要钱就能用**：装上就有免费模型。匿名免费池由 [our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 提供，插件由社区维护，不需要登录、不需要 key。想更好就换成自己的模型，一个地址就能切。
- **数据在你手里**：对话、记忆、定时任务都是本地 SQLite 和 Markdown 文件，拷走就是迁移。
- **断电不死**：回复生成到一半电脑被合上，重启后接着干，不会重复回你两遍。
- **能碰到的东西要你点头**：让它读写你的文件夹、执行命令，每次都要在聊天里回「是」。

## 快速开始 / Quick start

需要有 **Node.js 22 或更新**（[下载](https://nodejs.org)）。macOS、Linux、Windows 的 WSL 都行。

```sh
./install.sh          # 装依赖、装 magpie、配免费模型
pnpm start            # 启动
```

然后打开 <http://127.0.0.1:8787>，直接打字说话。

装完想知道它在哪、数据在哪、怎么换模型，看下面的配置表。

### 接到 Telegram

1. 在 Telegram 里找 **@BotFather**，`/newbot`，起个名字，拿到一串 token。
2. `./install.sh --telegram`，把 token 粘进去；或者自己填到 `.env` 的 `TELEGRAM_BOT_TOKEN=`。
3. `pnpm start`，给你的机器人发条消息。

**第一个跟它说话的账号会成为主人**，其他人发消息会被拒绝。想多几个人用，把他们的 id 加到 `.env` 的 `ALLOWED_USERS`（逗号分隔）。

## 进阶：用你自己的模型 / Bring your own model

免费池的代价是排队和限制。想稳定、想用大模型，两条路：

**自己的 key** — 打开 `magpie web`（默认 <http://127.0.0.1:3430>），Providers 里加一个，把 key 粘进去；再到 Routing 把 `free` 组里的模型换成你的，或者直接把 `.env` 的 `MAGPIE_MODEL` 改成 `auto/<模型名>`。

**本地模型** — 在 Ollama 或 vLLM 里起一个 OpenAI 兼容端点，然后：

```sh
magpie provider add ollama --base-url http://127.0.0.1:11434/v1 --api-key ollama
magpie group add mine 'models=ollama/*' routing=order
```

`.env` 里 `MAGPIE_MODEL=group/mine`，就完全离线了。

## 云端 / Cloud

```sh
cp .env.example .env        # 填 TELEGRAM_BOT_TOKEN 和 WEB_PASSWORD（公网一定要填）
docker compose -f deploy/docker-compose.yml up -d
```

只有网页端口对外，magpie 在内部网络里。要网页版一直开着，就把 `WEB_HOST=0.0.0.0` 留给容器、`WEB_PASSWORD` 设成你自己记得住的。

> 说明：免费池按出口 IP 限量。云服务器上大概率拿不到免费模型，云端模式请自带 key 或接本地模型。

## 它能做什么 / What it does

| 能力 | 怎么用 | 背后是什么 |
| --- | --- | --- |
| 聊天 | 直接说 | pi-durable 的持久化会话 |
| 记事 | 「记住我的车是蓝色比亚迪」 | `memory/` 下的 Markdown，索引每次进上下文，正文按需读 |
| 提醒 | 「明早七点叫我」 | `schedules` 表 + 每分钟检查，进程挂了补一次 |
| 长任务先回一句 | 它自己判断 | `send_message` 工具先发后干 |
| 读写文件 / 执行命令 | 在 `.env` 设 `WORKSPACE_DIR` | 每次执行前发审批卡，回「是」才动 |
| 网页 | `pnpm start` | 内置 HTTP 服务，无外部依赖 |
| Telegram | `.env` 填 token | 长轮询，不需要公网 IP |

## 配置 / Configuration

`.env`（从 `.env.example` 复制），全部有默认值：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `MAGPIE_MODEL` | `group/free` | 用哪个模型；免费池是 `group/free` |
| `MAGPIE_BASE_URL` | `http://127.0.0.1:3425` | 网关地址 |
| `DATA_DIR` | `~/.pi-magpie-bot` | 对话、记忆、任务都在这 |
| `WEB_PORT` / `WEB_HOST` | `8787` / `127.0.0.1` | 网页聊天；`WEB_PORT=0` 关掉 |
| `WEB_PASSWORD` | 空 | 设了就要密码才能进网页 |
| `TELEGRAM_BOT_TOKEN` | 空 | 填了就接 Telegram |
| `WORKSPACE_DIR` | 空 | 设了才允许读写文件、执行命令（每次要审批） |
| `ALLOWED_USERS` | 空 | 除主人外还允许谁说话 |

## 它是怎么搭的 / How it is built

站着不动就得靠靠谱的轮子，这个项目只在没人做的地方写自己的代码：

- **[pi-durable](https://github.com/earendil-works/pi)** —— 持久化运行、崩溃恢复、重试、压缩、信号与休眠，全在它上面。我们不重写执行引擎。
- **[magpie](https://github.com/yetone/magpie)** —— 一个网关说 OpenAI / Anthropic / Gemini 三种协议，路由组自动在多个免费模型间切换、失败换下一个。换模型不用改一行代码。
- **[our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)** 及其 [magpie 插件](https://github.com/mu-zi-lee/magpie-our-free-model) —— 匿名免费模型池。
- 上层这层薄薄的胶水（收件箱、发件箱、定时表、审批表、记忆目录、频道适配）是这个项目自己的，加起来不到两千行，看得完。

```
Telegram / 网页 ──▶ inbox（去重、排队）──▶ pi-durable 会话 ──▶ outbox ──▶ 你
                        ▲                      │
                        └── schedules ─────────┘   （定时任务）
```

## 已知的边界 / Honest limits

- 免费池**按 IP 限量**，忙的时候会排队或失败；`group/free` 会自动换下一个模型，但它不能变出额度。
- pi-durable 标着 *experimental*，升级时接口可能变；本项目钉在 `1.5.x`。
- 一个数据目录只能有一个进程在跑（SQLite 单写者）。
- 审批卡只认「是 / 否」这类短回答；开着卡的时候你说别的话，它会当作新消息。

## 开发 / Development

```sh
pnpm install
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest
pnpm smoke         # 直接问一遍网关里的第一个模型
pnpm smoke:bot     # 不用聊天平台，跑一遍完整链路
```

目录：`packages/gateway`（模型）、`packages/events`（宿主表）、`packages/memory`（记忆文件）、`packages/brain`（会话与工具）、`packages/channels/*`（Telegram、网页）、`apps/bot`（入口）。

## 许可 / License

MIT。第三方组件与出处见 [NOTICE.md](NOTICE.md)。

---

**English summary.** An always-on personal assistant built on [pi-durable](https://github.com/earendil-works/pi) with [magpie](https://github.com/yetone/magpie) as the single gateway to every model. It runs headless or in Docker, talks over Telegram or a built-in web page, remembers things in plain Markdown, keeps reminders in SQLite across restarts, and gates shell/file access behind an approval card in the chat. By default it uses an anonymous free model pool, so a first-time user needs no account and no key; `./install.sh` then `pnpm start` is the whole setup. MIT licensed.
