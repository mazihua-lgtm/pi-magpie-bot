# 用自己的模型 / Bring your own model

免费池够用，但它会排队、会到量，也不是最强的模型。换成自己的有两条路：买某个厂商的 key，或者在自己机器上跑一个模型。两种都在 magpie 里配，配完这个助理只认模型名，别的一行代码都不用改。

下面每条命令都在 2026-11-16 实测过（macOS，magpie 0.1.4280）。

## 一、用厂商的 key

```sh
magpie presets                        # 看 magpie 认识哪些厂商和它们的代号
magpie provider add deepseek sk-…     # 加：厂商代号 + key
magpie providers                      # 看现在有哪些、各有多少模型
```

模型名就是 `<厂商代号>/<模型名>`，比如 `deepseek/deepseek-chat`。

## 二、跑自己的模型

Ollama、vLLM、LM Studio、llama.cpp 都提供 OpenAI 兼容接口，加法和上面一样，只是把地址告诉它：

```sh
# Ollama 默认监听 11434，OpenAI 兼容接口带 /v1
magpie provider add ollama url=http://127.0.0.1:11434/v1 models=qwen3:8b

# 或者换一个本机服务，端口和模型名按实际填
magpie provider add mine url=http://127.0.0.1:8000/v1 models=Qwen2.5-7B-Instruct
```

`models=` 里可以写多个，用逗号隔开。加完模型名就是 `ollama/qwen3:8b`。

> 地址一定要写全 `/v1`，magpie 会自己接 `/chat/completions`。

## 三、让它用这个模型

两种办法，选一个：

**改 `.env`**（一行，重启生效）：

```sh
MAGPIE_MODEL=ollama/qwen3:8b
```

**或者建一个路由组**，把这家的模型都放进去，模型挂了一个换下一个：

```sh
magpie group add mine 'models=ollama/*' routing=order
# .env: MAGPIE_MODEL=group/mine
```

`routing=` 还能是 `smart`（挑最合适的）、`fast`（挑最近最快答话的）、`rotate`（轮流）、`drain`（用光一个再下一个）。

## 四、核对它真的走了你的模型

```sh
magpie provider ollama            # 这个厂商下面有哪些模型、key 有没有生效
magpie provider test ollama       # 让 magpie 当场问一次
pnpm smoke                        # 用网关里第一个模型问一句，看它回不回
```

要看请求落到哪，`magpie web`（默认 <http://127.0.0.1:3430>）里有请求日志。

## 五、几个会踩的坑

- **小模型不会调工具**：这个助理的记事、提醒、读文件都靠工具调用。模型不支持 tools（`/v1/models` 里 `tool_call: false`）也能聊天，但「提醒我关火」这类话它做不到，只会回你一段文字。
- **上下文太短**：助理每次都会带上系统提示、记忆索引和最近的消息，上下文低于 8k 的模型会一直报错。
- **本地模型很吃内存**：7B 级别至少 8G 内存，跑不动就换更小的量化版。
- **两条路可以并存**：免费池留着（`group/free`），自己的模型另建一组，改 `.env` 一个变量就切回来。

## 六、免费池到量之后，还有两个不用注册的端点

免费池这一轮全挂了（429 或 5xx），代理会往外再试一圈：OVHcloud 的公共推理端点（DeepSeek-V4.1-Flash、Qwen3.5-397B-A17B、gpt-oss-120b）和 Pollinations（gpt-oss-20b）。2026-11-18 实测：OVH 1–2 秒回，Pollinations 约 5 秒回，都不需要账号、不需要 key。

它们排在免费池后面，只有前面全试完才轮到，请求也不会把免费池的 key 带过去。代价是 **prompt 会发给这两家**，和发给免费池本身没有区别。

想关掉，或者换成自己的端点：

```sh
OFM_EXTRA_LANES='[]'                                                                      # 关掉
OFM_EXTRA_LANES='[{"name":"mine","url":"https://…/v1/chat/completions","model":"…"}]'      # 换掉
```

不带这个环境变量时，用的就是上面那四条内置车道（见 `scripts/ofm-proxy.mjs` 的 `DEFAULT_EXTERNAL`）。要带 key 的端点，在那一项里加 `"key"` 就行。

---

## In English

Point magpie at your own models, then tell this bot one model name.

- A vendor key: `magpie provider add <preset> <key>` (`magpie presets` lists the presets).
- A model on your machine behind an OpenAI-compatible endpoint:
  `magpie provider add ollama url=http://127.0.0.1:11434/v1 models=qwen3:8b`.
- Use it: `MAGPIE_MODEL=ollama/qwen3:8b` in `.env`, or gather several into a routing group
  (`magpie group add mine 'models=ollama/*' routing=order`, then `MAGPIE_MODEL=group/mine`).
- Check it answers: `magpie provider test <id>` and `pnpm smoke`.

Two limits worth knowing before you pick a model: the assistant's memory and reminders are
tool calls, so a model without tool support can only chat; and every turn carries the system
prompt plus memory, so a tiny context window will keep failing.
