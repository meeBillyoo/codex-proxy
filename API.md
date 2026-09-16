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

The service never returns Codex tokens or `PROXY_API_KEY` in API responses.
