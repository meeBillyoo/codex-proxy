import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

export interface CliAuthJson {
  auth_mode?: string;
  access_token?: string;
  id_token?: string;
  expires_at?: number;
  account_id?: string;
  tokens?: {
    access_token?: string;
    id_token?: string;
    expires_at?: number;
    account_id?: string;
  };
}

export function getCliAuthPath(): string {
  const codexHome = process.env.CODEX_HOME || resolve(homedir(), ".codex");
  return resolve(codexHome, "auth.json");
}

export function importCliAuth(): CliAuthJson {
  const authPath = getCliAuthPath();
  if (!existsSync(authPath)) throw new Error(`CLI auth file not found: ${authPath}`);

  const data = JSON.parse(readFileSync(authPath, "utf-8")) as CliAuthJson;
  const tokens = data.tokens ?? data;
  if (!tokens.access_token) throw new Error("CLI auth.json does not contain access_token");

  return {
    auth_mode: data.auth_mode,
    access_token: tokens.access_token,
    id_token: tokens.id_token,
    expires_at: tokens.expires_at,
    account_id: tokens.account_id,
  };
}
