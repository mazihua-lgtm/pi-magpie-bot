# pi-magpie-bot

<p align="center">
  <img src="docs/banner.png" alt="pi-magpie-bot" width="860">
</p>

<p align="center">
  <a href="https://github.com/mazihua-lgtm/pi-magpie-bot/actions/workflows/ci.yml"><img src="https://github.com/mazihua-lgtm/pi-magpie-bot/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
  <a href="https://github.com/mazihua-lgtm/pi-magpie-bot/releases"><img src="https://img.shields.io/github/v/release/mazihua-lgtm/pi-magpie-bot" alt="release"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A524-339933" alt="node 24+">
  <img src="https://img.shields.io/badge/Telegram%20%C2%B7%20Feishu%20%C2%B7%20WeCom%20%C2%B7%20Web-channels-5b8def" alt="channels">
</p>

<p align="center">中文 · <b><a href="README.en.md">English</a></b> · <a href="#快速开始--quick-start">快速开始</a> · <a href="#接到-telegram">Telegram</a> · <a href="#接到飞书">飞书</a> · <a href="#接到企业微信">企业微信</a> · <a href="docs/architecture.md">架构</a> · <a href="docs/own-models.md">自带模型</a></p>

**一个一直在线、会记事、会提醒你的私人助理。** 跑在你自己的电脑或服务器上，用免费模型就能开口说话：不用注册账号，不用 API key。在浏览器、Telegram、飞书、企业微信里都能找到它。

> An always-on personal assistant you run yourself: memory, reminders, free models out of the box (no account, no API key).

```
你：十分钟后提醒我关火
助理：好，10 分钟后我叫你。

（10 分钟后，即使电脑刚重启过）
助理：该关火啦。
```

## 为什么做这个 / Why this exists

Grok Bot 这类产品好用，但你的对话、记忆、日程都在别人服务器上，还要按月付费。这个项目把同样的东西拆开给你：

- **不要钱就能用**：免费池由 [our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 提供，插件由社区维护，不用注册账号、不用 key。第一次启动时自动装好、自动登录，之后就不用人管；想更稳、想用大模型，换成自己的就行，一个模型名就能切。
- **记录在你手里**：对话、记忆、定时任务都是本地 SQLite 和 Markdown 文件，拷走就是迁移（模型那一头见下面的「隐私」）。
- **断电不死**：消息先落盘再处理，重启后照常接着干，不会同一句回答你两遍；真被掐断在回答一半的那条，它会主动跟你说一声「刚才那条中断了」。
- **能碰到的东西要你点头**：让它读写你的文件夹、执行命令，每次都要在聊天里回「是」。

## 快速开始 / Quick start

**不用先装任何东西。** 打开终端（macOS：启动台里搜「终端」），粘贴这一行，回车：

```sh
curl -fsSL https://raw.githubusercontent.com/mazihua-lgtm/pi-magpie-bot/main/get.sh | bash
```

等几分钟（要下载几百 MB），浏览器会自动打开聊天页，直接打字说话。Node.js、pnpm 它自己装在 `~/.pi-magpie-bot` 里，不动系统别的东西；之后登录电脑它也会自己起来。macOS、Linux、Windows 的 WSL 都行（Windows 原生请用下面的 Docker）。

装好之后只记一个命令：

```sh
pi-magpie-bot status      # 在不在跑
pi-magpie-bot logs        # 看日志
pi-magpie-bot restart     # 重启（改了 .env 之后）
pi-magpie-bot update      # 更新到最新版
pi-magpie-bot uninstall   # 卸载（聊天记录和记忆默认留着）
```

![浏览器里说一句「十分钟后提醒我关火」，它就把提醒排进了日程：模型是免费的，没填任何 key](docs/chat.png)

**可以先对它说这些：**「十分钟后提醒我关火」「记住：我对花生过敏」「明天早上八点提醒我开会」「我刚才让你记了什么？」

### 隐私：一句话说清

对话记录、记忆、日程都存在你自己的电脑上。但**每句话都要发给模型才能得到回答**：用免费池时，内容会经过免费池背后的第三方渠道，别对它说密码、证件号这类敏感内容；换成自己的 key，就只发给你选的那家厂商。

### 手动安装（会用终端的）

需要 **Node.js 24 或更新**（[下载](https://nodejs.org)）和 pnpm。

```sh
pnpm install
pnpm start            # 启动
```

第一步之后就不用人管了：本机没有 magpie 的话它会自己下载官方发布版（比对 SHA256 再装），装上免费模型插件、登录它的匿名池、建好 `free` 路由组，最后才去连网关。想连 `.env` 一起生成就改用 `./install.sh`。然后打开 <http://127.0.0.1:8787>。

### 免费池要不要配置

不用。第一次启动时 bot 自己装好插件、用它自己的匿名池账号登录、建好 `group/free`，完了才去连网关——上面那张截图就是这么聊出来的，没人碰过终端。

想要更多额度，或者在匿名池排队时换条路，可以打开插件自己的控制台接一个渠道：

```sh
magpie plugin login our-free-model
```

先停掉 magpie 再运行（它要问运行中的网关要管理页，会被拒）。终端会打印一个地址——本机是 `127.0.0.1` 上的页面，服务器上是临时的 `trycloudflare.com` 地址（都不用注册）；打开它按页面提示接渠道，然后重新启动 bot。不接也能用。

插件第一次安装要从 `raw.githubusercontent.com` 取它自己的渠道包。那个地址连不上的网络里免费池起不来，安装脚本和网页都会直说原因（`原渠道包下载失败`），不会假装装好了——这种网络下请直接用自己的模型。

### 接到 Telegram

1. 在 Telegram 里找 **@BotFather**，`/newbot`，起个名字，拿到一串 token。
2. `./install.sh --telegram`，把 token 粘进去；或者自己填到 `.env` 的 `TELEGRAM_BOT_TOKEN=`。
3. `pnpm start`，给你的机器人发条消息。

**第一个跟它说话的账号会成为主人**，其他人发消息会被拒绝。想多几个人用，把他们的 id 加到 `.env` 的 `ALLOWED_USERS`（逗号分隔）。

### 接到飞书

不需要公网地址（用官方长连接）。

1. 在 open.feishu.cn 建一个**企业自建应用**，开启「机器人」能力，加上权限「获取用户发给机器人的单聊消息」（`im:message.p2p_msg:readonly`）和「以应用身份发消息」（`im:message:send_as_bot`）。
2. 事件订阅选「**使用长连接接收事件**」，添加事件 `im.message.receive_v1`，然后发布版本。
3. 把应用的 App ID 和 App Secret 填到 `.env` 的 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`（国际版 Lark 再把 `FEISHU_DOMAIN` 改成 `lark`），`pnpm start`，看到 `[feishu] connected` 就是通了，在飞书里给机器人发单聊消息。

只回单聊，群聊忽略；和 Telegram 一样，第一个跟它说话的人成为主人。目前只看得懂文字消息。

### 接到企业微信

不需要公网地址（用官方长连接）。**这是企业微信，不是个人微信**：只有你企业微信里的同事/自己能找到它。

1. 企业微信管理后台 →「安全与管理」→「管理工具」→「智能机器人」→ 创建，选「API 模式」→「长连接」，拿到 Bot ID 和 Secret。
2. 把它们填到 `.env` 的 `WECOM_BOT_ID`、`WECOM_BOT_SECRET`，`pnpm start`，看到 `[wecom] connected` 就是通了，在企业微信里给机器人发单聊消息。

只回单聊，群聊忽略；第一个跟它说话的人成为主人。看得懂文字和语音（用平台自己的转写），图片文件会提示不支持。还没拿真实机器人验证过，遇到问题请提 issue。

## 进阶：用你自己的模型 / Bring your own model

免费池的代价是排队和限制。想稳定、想用大模型，两条路：

**自己的 key** —— 不用开终端：免费池给不出模型时，bot 自己会把「还差一步」的页面挂出来，页面上直接有厂商下拉框和一个 key 输入框，贴进去点「保存并继续」，同一个进程就接着启动、进聊天页。想在聊天里加第二次，或者用命令行，`magpie provider add deepseek sk-…`（`magpie presets` 看全部厂商），或者打开 `magpie web`（默认 <http://127.0.0.1:3430>）在页面里加。

**本地模型** — Ollama / vLLM / LM Studio 起一个 OpenAI 兼容端点，然后：

```sh
magpie provider add ollama url=http://127.0.0.1:11434/v1 models=qwen3:8b
```

`.env` 里把 `MAGPIE_MODEL` 改成 `ollama/qwen3:8b`，就完全离线了。

每一步、每个坑（哪些模型不能调工具、上下文要多长）写在 **[docs/own-models.md](docs/own-models.md)**。

## 云端 / Cloud

一个容器，什么都在里面：

```sh
cp .env.example .env        # 至少填 WEB_PASSWORD；要接 Telegram 等再填对应几行
docker compose up -d        # 在仓库根目录跑，.env 就在旁边
```

打开 `http://<服务器地址>:8787`，输入 `WEB_PASSWORD` 就能聊天。手机浏览器里点「添加到主屏幕」，它就有图标、全屏打开，用起来跟 App 一样（不用装任何东西，也不用上架应用商店）。容器里的 bot 自己带着 magpie（第一次启动要下载，要几分钟），没有网关密钥、没有 `exec` 命令要敲。对话、记忆、定时任务和 magpie 的 key 都在一个数据卷里，重建容器不丢。

没有可用模型时 bot 不会反复重启：网页上有一页说明，还带一个框，贴上自己的 key（页面给了各家的注册链接）就行。云端这个框**必须**先输 `WEB_PASSWORD` 才能保存，没设密码就不显示，避免被人顺手改了你的 key。

默认只发布到本机（`WEB_BIND=127.0.0.1`）；要让手机或别的设备访问，把 `WEB_BIND` 改成 `0.0.0.0`，并且一定设上 `WEB_PASSWORD`。

想把 magpie 单独放一个容器（比如多个 bot 共用一个网关），用 `docker compose -f compose.split.yml up -d`，步骤写在那个文件的开头。

> 说明：免费池按出口 IP 限量，云服务器上大概率拿不到免费模型，云端请自带 key 或接本地模型。容器里下载 magpie 要能访问 github.com，下不来时日志会直说，并退回上面那一页。

## 它能做什么 / What it does

| 能力 | 怎么用 | 背后是什么 |
| --- | --- | --- |
| 聊天 | 直接说 | pi-durable 的持久化会话 |
| 记事 | 「记住我的车是蓝色比亚迪」 | `memory/` 下的 Markdown，索引每次进上下文，正文按需读 |
| 提醒 | 「明早七点叫我」 | `schedules` 表 + 每 2 秒看一次（`TICK_MS` 可改），进程挂了下次启动补一次 |
| 长任务先回一句 | 它自己判断 | `send_message` 工具先发后干 |
| 读写文件 / 执行命令 | 在 `.env` 设 `WORKSPACE_DIR` | 每次执行前发审批卡，回「是」才动 |
| 网页 | `pnpm start` | 内置 HTTP 服务，无外部依赖 |
| Telegram | `.env` 填 token | 长轮询，不需要公网 IP |
| 飞书 / Lark | `.env` 填 App ID 和 Secret | 官方长连接，不需要公网 IP |
| 企业微信 | `.env` 填 Bot ID 和 Secret | 官方长连接，不需要公网 IP；不是个人微信 |

## 配置 / Configuration

`.env`（从 `.env.example` 复制），全部有默认值：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `MAGPIE_MODEL` | `group/free` | 用哪个模型；免费池是 `group/free` |
| `MAGPIE_BASE_URL` | `http://127.0.0.1:3425` | 网关地址 |
| `MAGPIE_START` | `1` | 设 `0` 就只连现成的 magpie，不自己启动（Docker/远程网关） |
| `DATA_DIR` | `~/.pi-magpie-bot` | 对话、记忆、任务都在这 |
| `TZ` | 系统时区 | 提醒和「现在几点」按它算；Docker 里默认 `Asia/Shanghai` |
| `WEB_PORT` / `WEB_HOST` | `8787` / `127.0.0.1` | 网页聊天；`WEB_PORT=0` 关掉 |
| `WEB_PASSWORD` | 空 | 设了就要密码才能进网页 |
| `WEB_BIND` | `127.0.0.1` | 仅 compose：网页端口发布到哪个地址 |
| `TELEGRAM_BOT_TOKEN` | 空 | 填了就接 Telegram |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 空 | 两个都填了就接飞书 |
| `FEISHU_DOMAIN` | `feishu` | 国际版 Lark 填 `lark` |
| `WECOM_BOT_ID` / `WECOM_BOT_SECRET` | 空 | 两个都填了就接企业微信 |
| `WORKSPACE_DIR` | 空 | 设了才允许读写文件、执行命令（每次要审批） |
| `ALLOWED_USERS` | 空 | 除主人外还允许谁说话 |

## 它是怎么搭的 / How it is built

站着不动就得靠靠谱的轮子，这个项目只在没人做的地方写自己的代码：

- **[pi-durable](https://github.com/earendil-works/pi)** —— 持久化运行、崩溃恢复、重试、压缩、信号与休眠，全在它上面。我们不重写执行引擎。
- **[magpie](https://github.com/yetone/magpie)** —— 一个网关说 OpenAI / Anthropic / Gemini 三种协议，路由组自动在多个免费模型间切换、失败换下一个。换模型不用改一行代码。
- **[our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)** 及其 [magpie 插件](https://github.com/mu-zi-lee/magpie-our-free-model) —— 匿名免费模型池。
- 上层这层薄薄的胶水（收件箱、发件箱、定时表、审批表、记忆目录、频道适配）是这个项目自己的，`packages/*/src` 加起来三千行上下，看得完。

```
Telegram / 飞书 / 企业微信 / 网页 ──▶ inbox（去重、排队）──▶ pi-durable 会话 ──▶ outbox ──▶ 你
                        ▲                      │
                        └── schedules ─────────┘   （定时任务）
```

数据怎么落、五件事各自归谁、断电重启后哪条消息会重来哪条不会：**[docs/architecture.md](docs/architecture.md)**。

## 已知的边界 / Honest limits

- 免费池**按 IP 限量**，忙的时候会排队或失败（`Our Free Model: Free usage limit reached` 就是这一条）；`group/free` 会自动换下一个模型，但它不能变出额度。
- 免费池的登录过期、或上游改接口时，再跑一次 `magpie plugin login our-free-model`（先停 magpie），或者换自己的模型。
- pi-durable 标着 *experimental*，升级时接口可能变；本项目钉在 `1.5.x`。
- 一个数据目录只能有一个进程在跑（SQLite 单写者）。
- 审批卡只认「是 / 否」这类短回答；开着卡的时候你说别的话，它会当作新消息。
- 本机已经装了 magpie 时，`install.sh` 不会动它（不加插件、不登录、不启动）；想让脚本把免费池加进去，加 `--manage-existing-magpie`。
- 读、写、改文件和跑命令**都要你点头**；但工作目录之外的路径只靠这张审批卡把关，没有沙箱，批之前看清路径。
- Telegram 只接私聊，群消息一律忽略；设了 `ALLOWED_USERS` 就不再「先到先得」认主人，只有名单里的人能用。
- Telegram 的消息偏移在处理前就前进：处理中途崩溃，那一条消息会丢（最多一次，不会重复回答）。

## 开发 / Development

```sh
pnpm install
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest
pnpm smoke         # 直接问一遍网关里的第一个模型
pnpm smoke:bot     # 不用聊天平台，跑一遍完整链路
```

目录：`packages/gateway`（模型）、`packages/events`（宿主表）、`packages/memory`（记忆文件）、`packages/brain`（会话与工具）、`packages/channels/*`（Telegram、飞书、企业微信、网页）、`apps/bot`（入口）。

## 许可 / License

MIT。第三方组件与出处见 [NOTICE.md](NOTICE.md)。

---

**English.** A full English README, one to one with this one, is at **[README.en.md](README.en.md)**.
