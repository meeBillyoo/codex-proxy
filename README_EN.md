# Codex Proxy

Codex Proxy exposes the Codex CLI account logged in by the current OS user through OpenAI-, Anthropic-, Gemini-, and Codex Responses-compatible APIs.

This build is intentionally single-account:

- Credentials are read only from `$CODEX_HOME/auth.json`, or `~/.codex/auth.json` by default.
- Login, refresh, and logout belong to the official Codex CLI. This service does not persist or refresh credentials.
- There is no account import, account pool, rotation, third-party provider key store, or client-key system.
- Every proxy endpoint and the dashboard login use `PROXY_API_KEY` from the process environment.

## Install and run

Node.js 24 and Codex CLI are required.

```bash
codex login
npm ci
cd web && npm ci && cd ..
npm run build

export PROXY_API_KEY='replace-with-a-strong-random-secret'
export CODEX_PROXY_HOST=127.0.0.1
export PORT=8080
npm start
```

Open `http://127.0.0.1:8080/` and sign in with `PROXY_API_KEY`.

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Reply only with ok"}],"stream":false}'
```

Use `POST /auth/reload` to reread the CLI auth file after it changes. See [API.md](./API.md) and [docs/SERVER_DEPLOYMENT_8221.md](./docs/SERVER_DEPLOYMENT_8221.md) for details.

## How this build differs from upstream

This repository is based on [icebear0828/codex-proxy](https://github.com/icebear0828/codex-proxy), but is intentionally scoped to “a stable server proxy for the one Codex CLI account logged in on this machine.” The main requirement-level changes are:

| Area | Upstream | This repository |
| --- | --- | --- |
| Runtime | Electron desktop, Lite, Docker, and source deployments | Node.js server and browser Dashboard only; PM2 is the supported production process manager |
| Accounts | Account import, pools, rotation, fallback accounts, and session affinity across accounts | Exactly one account from the current OS user's Codex CLI; no import, rotation, or cross-account retry |
| Credentials | Application-managed persistence and refresh for multiple credentials | Read-only access to `CODEX_HOME/auth.json`; the official Codex CLI owns login, refresh, and logout |
| Authentication | Multiple upstream and client key systems | One process-injected `PROXY_API_KEY` protects proxy endpoints and the Dashboard |
| Upstreams | Configurable third-party providers, API keys, proxy groups, and model routing | Codex official upstream as the account source, with OpenAI, Anthropic, Gemini, and Images protocol adapters retained |
| Dashboard | Account, key, proxy-pool, and rotation management | Current CLI account, quota, request logs, usage statistics, and service settings |
| Usage and billing | Multi-account/provider billing model | Virtual usage snapshots based on the current account's weekly quota plus OpenAI-compatible usage/billing endpoints |
| Deployment constraints | Node.js 18+ and several packaged distribution paths | Node.js 24 is required; project-specific Docker, Electron, and systemd release flows were removed |

These changes deliberately remove configuration and operational surface that is not needed for a single-account server. Protocol translation and Codex Responses (including SSE and WebSocket) remain supported.

This project does not ship Docker, Electron, or a project-specific systemd deployment. Use PM2 for server process management.

Originally evolved from [icebear0828/codex-proxy](https://github.com/icebear0828/codex-proxy). See [LICENCE](./LICENCE).
