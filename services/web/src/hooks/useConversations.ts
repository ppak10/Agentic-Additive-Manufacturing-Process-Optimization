import { useEffect, useState } from "react";

// Recent conversations for the sidebar's ChatGPT-style list. Slow poll —
// new conversations appear within half a minute.

export interface ConversationSummary {
  id: number;
  created_at: string;
  last_at: string | null;
  harness: string;
  role: string;
  model: string | null;
  title: string | null;
}

export function useConversations(limit = 15, intervalMs = 30_000): ConversationSummary[] | null {
  const [rows, setRows] = useState<ConversationSummary[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/agent/conversations?limit=${limit}`);
        if (r.ok && !cancelled) setRows(await r.json());
      } catch { /* broker down — sidebar section just stays empty */ }
    };
    void tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [limit, intervalMs]);
  return rows;
}
