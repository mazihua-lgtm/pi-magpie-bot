# 参与 / Contributing

欢迎 issue 和 PR。这个项目的原则：**不重复造轮子**，只写没人做的那层胶水；改动小、有测试、说人话。

Issues and PRs are welcome. The rule here: don't reinvent wheels, write only the glue nobody else has, keep changes small and tested.

```sh
pnpm install
pnpm typecheck
pnpm test
```

- 要加一个聊天入口：照 `packages/channels/feishu` 的样子做，把平台换成「一个能收消息、能发消息」的小接口，测试里用假传输层，不连真网络。
- 改了环境变量：同步 `.env.example` 和中英文两份 README 的配置表。
- 新依赖请是 MIT / Apache-2.0 / BSD 这类宽松许可，并写进 [NOTICE.md](NOTICE.md)。
- 提交信息写清楚改了什么、为什么。
