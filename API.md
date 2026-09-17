# Codex Proxy API

All proxy endpoints require `Authorization: Bearer <PROXY_API_KEY>`. Anthropic and Gemini clients may use `x-api-key` or `x-goog-api-key` with the same environment-provided secret.

## Protocol endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/v1/responses` | Codex Responses over HTTP SSE or WebSocket |
| POST | `/v1/responses/review` | Responses request marked as a review subagent |
| POST | `/v1/responses/compact` | Codex compact |
| POST | `/v1/messages` | Anthropic Messages |
| POST | `/v1/messages/count_tokens` | Local token estimate |
| POST | `/v1beta/models/:modelAction` | Gemini generate/stream content |
| POST | `/v1/images/generations` | OpenAI Images-compatible generation |
| GET | `/v1/models` | Model list |

## CLI account endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/auth/status` | CLI authentication status and auth-file path |
| GET | `/auth/account` | Current CLI account, quota, and usage without credentials |
| POST | `/auth/reload` | Reread the current OS user's Codex CLI auth file |

There are no login, logout, import, deletion, rotation, provider-key, client-key, or token-refresh APIs. Use `codex login` and `codex logout` as the same OS user that runs the service.

## Codex App Server sessions

When `official_agent.enabled` is enabled, the session API provides multiple independent conversations. Different sessions can run concurrently; turns within the same session remain ordered.

| Method | Path | Description |
|---|---|---|
| POST | `/official-agent/sessions` | Create a session and return its `sessionId` and upstream `threadId` |
| GET | `/official-agent/sessions` | List sessions held by this process |
| GET | `/official-agent/sessions/:sessionId` | Get session status and active turn |
| DELETE | `/official-agent/sessions/:sessionId` | Interrupt its active turn, archive the upstream thread, and delete the local session |
| POST | `/official-agent/sessions/:sessionId/turns` | Start an SSE turn in a session |
| POST | `/official-agent/sessions/:sessionId/turns/:turnId/cancel` | Interrupt the active turn |

All endpoints require `Authorization: Bearer <PROXY_API_KEY>`. Sessions are held in memory and must be recreated after a server restart.

The default limit is 50 sessions (`official_agent.max_sessions`). Idle sessions are automatically archived and removed after 24 hours without activity (`official_agent.session_idle_ttl_hours`); running sessions are never removed mid-turn. A cancel request received before the upstream `turnId` is known is acknowledged with HTTP 202 and applied as soon as `turn/start` returns. Disconnecting an SSE client also requests cancellation of the upstream turn. If the App Server does not implement `thread/archive`, local cleanup still completes and the delete response reports `archived: false`.

The service never returns Codex tokens or `PROXY_API_KEY` in API responses.
