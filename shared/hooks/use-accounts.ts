import { useCallback, useEffect, useState } from "preact/hooks";
import type { Account } from "../types";

interface AccountResponse {
  account: Account;
  auth_file: string;
}

export function useAccounts() {
  const [account, setAccount] = useState<Account | null>(null);
  const [authFile, setAuthFile] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/auth/account");
      const data = await response.json();
      setAuthFile(data.auth_file ?? "");
      if (!response.ok) {
        setAccount(null);
        setError(data.error ?? `HTTP ${response.status}`);
        return;
      }
      setAccount((data as AccountResponse).account);
      setError(null);
      setLastUpdated(new Date());
    } catch (cause) {
      setAccount(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/auth/reload", { method: "POST" });
      const data = await response.json();
      setAuthFile(data.auth_file ?? authFile);
      if (!response.ok) {
        setError(data.error ?? `HTTP ${response.status}`);
        return false;
      }
      setAccount((data as AccountResponse).account);
      setError(null);
      setLastUpdated(new Date());
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [authFile]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  return { account, authFile, loading, refreshing, lastUpdated, error, reload };
}
