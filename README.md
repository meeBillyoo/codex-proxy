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

项目最初由 [icebear0828/codex-proxy](https://github.com/icebear0828/codex-proxy) 演进而来；许可证见 [LICENSE](./LICENSE)。
