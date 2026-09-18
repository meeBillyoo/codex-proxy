import { useCallback, useEffect, useState } from "preact/hooks";

export interface ResetCreditsSnapshot {
  available_count: number | null;
  next_expires_at: number | null;
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function useResetCredits() {
  const [snapshot, setSnapshot] = useState<ResetCreditsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const response = await fetch("/auth/reset-credits", {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return false;
      const data = await response.json() as ResetCreditsSnapshot;
      setSnapshot({
        available_count: typeof data.available_count === "number" ? data.available_count : null,
        next_expires_at: typeof data.next_expires_at === "number" ? data.next_expires_at : null,
      });
      return true;
    } catch {
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => { void reload(); }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  return { snapshot, loading, reload };
}
