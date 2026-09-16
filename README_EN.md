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

This project does not ship Docker, Electron, or a project-specific systemd deployment. Use PM2 for server process management.

Originally evolved from [icebear0828/codex-proxy](https://github.com/icebear0828/codex-proxy). See [LICENSE](./LICENSE).
