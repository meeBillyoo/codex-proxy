import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

const codexHome = resolve("/tmp", `codex-proxy-auth-${process.pid}`);
const dataDir = resolve("/tmp", `codex-proxy-data-${process.pid}`);
mkdirSync(codexHome, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
const payload = Buffer.from(JSON.stringify({
  exp: Math.floor(Date.now() / 1000) + 3600,
  "https://api.openai.com/profile": { email: "codex-cli@test.local" },
  "https://api.openai.com/auth": {
    chatgpt_account_id: "account-test",
    chatgpt_plan_type: "plus",
    chatgpt_user_id: "user-test",
  },
})).toString("base64url");

writeFileSync(resolve(codexHome, "auth.json"), JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: `${header}.${payload}.signature`,
    refresh_token: "test-refresh-token",
    account_id: "account-test",
  },
}));

process.env.CODEX_HOME = codexHome;
process.env.CODEX_PROXY_DATA_DIR = dataDir;
process.env.PROXY_API_KEY = "master-key-123";
