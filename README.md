# Codex Proxy

Codex Proxy 将当前系统用户已经登录的 Codex CLI 账号转换为 OpenAI、Anthropic、Gemini 和 Codex Responses 兼容接口。

当前版本是严格的单账号模式：

- 只读取 `$CODEX_HOME/auth.json`，未设置 `CODEX_HOME` 时读取 `~/.codex/auth.json`。
- 登录、续期和退出由官方 Codex CLI 负责；本项目不保存或刷新凭据。
- 不支持账号导入、账号池、轮换、第三方 Provider Key 或内部客户端 Key。
- 所有代理接口和 Dashboard 登录统一使用环境变量 `PROXY_API_KEY`。
- Dashboard 只显示当前 CLI 账号、额度、请求日志和服务设置。

## 安装

要求 Node.js 24 和已经安装的 Codex CLI：

```bash
node --version
codex login

npm ci
cd web && npm ci && cd ..
npm run build
```

确认认证文件存在：

```bash
test -f "${CODEX_HOME:-$HOME/.codex}/auth.json" && echo "Codex CLI 已登录"
```

## 启动

```bash
export PROXY_API_KEY='替换为高强度随机密钥'
export CODEX_PROXY_HOST=127.0.0.1
export PORT=8080
npm start
```

默认优先使用上游 Responses WebSocket，并在不依赖 `previous_response_id`
的请求发生握手或传输故障时自动、安全地回退到 HTTP SSE。只有部署网络完全不支持
上游 WebSocket 时，才设置 `CODEX_PROXY_DISABLE_WS=1`；此模式保留完整历史请求，
但显式 `previous_response_id` 续链会返回错误而不会静默丢失上下文。

服务启动后打开 `http://127.0.0.1:8080/`，使用 `PROXY_API_KEY` 登录 Dashboard。认证文件变化后可重启进程，或调用：

```bash
curl -X POST http://127.0.0.1:8080/auth/reload \
  -H "Authorization: Bearer $PROXY_API_KEY"
```

## 调用示例

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.6-sol",
    "messages": [{"role": "user", "content": "只回复 ok"}],
    "stream": false
  }'
```

常用接口：

- `POST /v1/chat/completions`：OpenAI Chat Completions
- `POST /v1/responses`：Codex Responses 直通，支持 HTTP SSE 和 WebSocket
- `POST /v1/responses/compact`：Codex compact
- `POST /v1/messages`：Anthropic Messages
- `POST /v1/messages/count_tokens`：Anthropic token 估算
- `POST /v1beta/models/:modelAction`：Gemini generateContent
- `POST /v1/images/generations`：OpenAI Images 兼容接口
- `GET /v1/models`：模型列表
- `GET /auth/account`：当前 CLI 账号（不返回 token）
- `POST /auth/reload`：重新读取 CLI 认证文件

完整接口说明见 [API_CN.md](./API_CN.md)，服务器部署见 [docs/SERVER_DEPLOYMENT_8221.md](./docs/SERVER_DEPLOYMENT_8221.md)。

## 与源工程的差异（需求范围）

本仓库基于 [icebear0828/codex-proxy](https://github.com/icebear0828/codex-proxy)，面向“当前机器上的一个 Codex CLI 账号提供稳定的服务器代理”这一场景做了收敛。以下是与源工程相比的主要需求级修改：

| 领域 | 源工程 | 本仓库 |
| --- | --- | --- |
| 运行形态 | Electron 桌面端、Lite、Docker 和源码部署并存 | 仅保留 Node.js 服务端和浏览器 Dashboard；生产进程使用 PM2 管理 |
| 账号模型 | 支持多账号导入、账号池、轮换、回退账号和账号间会话粘滞 | 固定使用当前操作系统用户登录的单个 Codex CLI 账号，不做账号导入、轮换或跨账号重试 |
| 凭据管理 | 应用可保存、刷新和管理多组凭据 | 只读取 `CODEX_HOME/auth.json`；登录、续期、退出全部交给官方 Codex CLI，应用不持久化 token |
| 访问控制 | 可配置多种上游/客户端 Key | 所有代理接口和 Dashboard 统一使用进程环境中的 `PROXY_API_KEY` |
| 上游能力 | 可配置第三方 Provider、API Key、代理组和模型路由 | 以 Codex 官方上游为唯一账号来源，保留 OpenAI、Anthropic、Gemini、Images 等兼容协议转换 |
| Dashboard | 账号管理、Key 管理、代理池和轮换设置 | 只展示当前 CLI 账号、额度、请求日志、用量统计和服务设置 |
| 计费与用量 | 面向多账号/多 Provider 的计费模型 | 增加按当前账号周额度计算的虚拟用量快照，并提供 OpenAI 兼容的用量/计费查询接口 |
| 部署约束 | 支持 Node.js 18+ 及多种发行制品 | 统一要求 Node.js 24；移除项目专用 Docker、Electron 和 systemd 发布流程 |

这些收敛是有意的：减少不再适用的账号池、上游路由和发行代码，降低单账号服务器部署的配置与运维成本；API 协议转换和 Codex Responses（含 SSE/WebSocket）能力保持不变。

## PM2 部署

```bash
pm2 start dist/index.js \
  --name codex-proxy \
  --cwd /absolute/path/to/codex-proxy \
  --interpreter "$(command -v node)" \
  --time
pm2 save
```

本项目不提供 Docker、Electron 或项目专用 systemd 部署方式。

## 安全说明

- 建议默认只监听 `127.0.0.1`；公网使用时在前面配置 HTTPS 反向代理和来源限制。
- 不要复制、上传或记录 `auth.json` 的内容。
- `PROXY_API_KEY` 必须通过进程环境注入，不写入 `local.yaml`。

项目最初由 [icebear0828/codex-proxy](https://github.com/icebear0828/codex-proxy) 演进而来；许可证见 [LICENCE](./LICENCE)。
