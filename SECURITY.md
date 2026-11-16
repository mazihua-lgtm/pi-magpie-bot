# 安全 / Security

发现安全问题，请用 GitHub 的私密通道报告：<https://github.com/mazihua-lgtm/pi-magpie-bot/security/advisories/new>，不要开公开 issue，也不要在任何地方贴出 API key、token 或 `.env`。

Found a security problem? Please report it privately through
<https://github.com/mazihua-lgtm/pi-magpie-bot/security/advisories/new>. Do not open a public issue, and never paste keys, tokens or your `.env` anywhere.

## 默认的安全姿势 / Defaults

- 网页只监听 `127.0.0.1`；放到公网必须设 `WEB_PASSWORD`（启动时会提醒）。
- 读、写、改文件和执行命令每次都要在聊天里点头；没设 `WORKSPACE_DIR` 就根本没有这些工具。
- 第一个说话的账号成为主人；设了 `ALLOWED_USERS` 则只有名单里的人能用。
- `install.sh` 生成的 `.env` 权限为 0600；填 key 的页面出错时不会把 key 回显出来。

已知边界（没有沙箱、Telegram 偏移至多一次）写在 README 的「已知的边界」里。
