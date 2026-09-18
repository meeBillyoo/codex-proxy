# Codex Proxy API

## 鉴权

除 `/health`、Dashboard 静态资源和 Dashboard 登录接口外，请求必须携带：

```http
Authorization: Bearer <PROXY_API_KEY>
```

Anthropic 和 Gemini 客户端也可分别使用 `x-api-key`、`x-goog-api-key`，值仍为同一个 `PROXY_API_KEY`。

## 协议接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI Chat Completions，支持流式和非流式 |
| POST | `/v1/responses` | Codex Responses；HTTP SSE 或 WebSocket |
| POST | `/v1/responses/review` | 带 review 子代理标记的 Responses 请求 |
| POST | `/v1/responses/compact` | Codex compact |
| POST | `/v1/messages` | Anthropic Messages |
| POST | `/v1/messages/count_tokens` | 本地 token 数量估算 |
| POST | `/v1beta/models/:modelAction` | Gemini `generateContent` / `streamGenerateContent` |
| POST | `/v1/images/generations` | OpenAI Images 兼容接口 |
| GET | `/v1/models` | OpenAI 模型列表 |
| GET | `/v1/models/catalog` | 完整模型元数据 |
| GET | `/v1/models/:modelId` | 单个模型 |
| GET | `/v1/models/:modelId/info` | 单个模型扩展信息 |

## CLI 账号接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/auth/status` | 当前 CLI 认证状态和认证文件路径 |
| GET | `/auth/account` | 当前 CLI 账号、状态、额度和用量；不返回凭据 |
| POST | `/auth/reload` | 重新读取当前系统用户的 Codex CLI `auth.json` |

本服务没有登录、退出、导入、删除、轮换或 token 刷新接口。请在运行服务的同一系统用户下使用 `codex login` / `codex logout`。

## Codex App Server 会话接口

启用 `official_agent.enabled` 后，可通过以下接口管理多个独立对话。不同 session 可以并行执行，同一个 session 内的 turn 仍按顺序执行。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/official-agent/sessions` | 创建 session，并返回 `sessionId` 与上游 `threadId` |
| GET | `/official-agent/sessions` | 列出当前进程维护的 session |
| GET | `/official-agent/sessions/:sessionId` | 查询 session 状态和当前 turn |
| DELETE | `/official-agent/sessions/:sessionId` | 中断运行中的 turn、归档上游 thread 并删除本地 session |
| POST | `/official-agent/sessions/:sessionId/turns` | 在指定 session 中发起 SSE turn |
| POST | `/official-agent/sessions/:sessionId/turns/:turnId/cancel` | 中断指定的运行中 turn |

所有接口都需要 `Authorization: Bearer <PROXY_API_KEY>`。session 是进程内状态，服务重启后需要重新创建。

默认最多保留 50 个 session（`official_agent.max_sessions`）。session 连续 24 小时无活动后会自动归档上游 thread 并清理（`official_agent.session_idle_ttl_hours`）；运行中的 turn 不会被中途清理。若取消请求到达时上游 `turnId` 尚未返回，接口返回 HTTP 202，拿到 `turnId` 后会自动发送中断。SSE 客户端断开也会自动请求取消上游 turn。如果 App Server 不支持 `thread/archive`，本地 session 仍会清理，删除响应中的 `archived` 会为 `false`。

turn 的 SSE 流首先发送 `official_agent.turn_started`，其中包含本地 `sessionId` 和 `turnId`。取消接口使用这个本地 `turnId`；后续 `official_agent.result` 事件则包含 App Server 返回的上游结果。

## Dashboard 与运维

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/dashboard-login` | 使用 `PROXY_API_KEY` 登录 Dashboard |
| POST | `/auth/dashboard-logout` | 删除 Dashboard session |
| GET | `/auth/dashboard-status` | Dashboard session 状态 |
| GET | `/health` | 服务与当前账号状态 |
| GET/POST | `/admin/general-settings` | 非敏感运行设置 |
| GET | `/admin/api-config` | 当前 API 密钥（仅已登录 Dashboard 会话） |
| GET/POST | `/admin/quota-settings` | 额度刷新和预警设置 |
| GET | `/admin/usage-stats/summary` | 用量汇总 |
| GET | `/admin/usage-stats/history` | 用量历史 |
| GET | `/admin/logs` | 请求日志 |
| GET | `/admin/error-logs` | 错误日志 |

接口不会返回 CLI access token、refresh token 或 ID token。已登录的 Dashboard 可通过受会话保护的 `/admin/api-config` 读取当前 `PROXY_API_KEY`，用于接口页展示和连通性测试。
