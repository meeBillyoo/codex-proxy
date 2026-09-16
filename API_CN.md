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

## Dashboard 与运维

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/dashboard-login` | 使用 `PROXY_API_KEY` 登录 Dashboard |
| POST | `/auth/dashboard-logout` | 删除 Dashboard session |
| GET | `/auth/dashboard-status` | Dashboard session 状态 |
| GET | `/health` | 服务与当前账号状态 |
| GET/POST | `/admin/general-settings` | 非敏感运行设置 |
| GET/POST | `/admin/quota-settings` | 额度刷新和预警设置 |
| GET | `/admin/usage-stats/summary` | 用量汇总 |
| GET | `/admin/usage-stats/history` | 用量历史 |
| GET | `/admin/logs` | 请求日志 |
| GET | `/admin/error-logs` | 错误日志 |

接口不会返回 CLI access token、refresh token、ID token 或 `PROXY_API_KEY`。
