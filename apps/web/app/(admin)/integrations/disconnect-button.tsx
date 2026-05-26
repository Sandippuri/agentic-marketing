"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SocialProvider } from "@marketing/shared-types";

// Calls DELETE /api/oauth/{provider} then refreshes the page so the server
// component re-fetches the connection list. Lives next to the integrations
// page rather than in /components because it's specific to this view.

export function DisconnectButton({
  provider,
  label = "Disconnect",
}: {
  provider: SocialProvider;
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/oauth/${provider}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Disconnect failed (${res.status})`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="btn btn-secondary btn-sm disabled:opacity-50"
      >
        {busy ? "Disconnecting…" : label}
      </button>
      {error && <span className="text-[11px] text-[var(--danger)]">{error}</span>}
    </div>
  );
}
