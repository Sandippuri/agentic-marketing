"use client";

import { useState, useTransition } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";

type Status =
  | { kind: "idle" }
  | { kind: "sent"; email: string }
  | { kind: "error"; message: string };

export function LoginForm({ next, error }: { next: string; error?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>(
    error ? { kind: "error", message: error } : { kind: "idle" },
  );
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const supabase = getSupabaseBrowser();
      const { error: err } = await supabase.auth.signInWithOtp({
        email,
        options: {
          // /auth/callback exchanges the OTP for a session cookie, then
          // redirects to `next`.
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (err) setStatus({ kind: "error", message: err.message });
      else setStatus({ kind: "sent", email });
    });
  }

  if (status.kind === "sent") {
    return (
      <div className="rounded border border-zinc-200 dark:border-zinc-800 p-4 text-sm">
        Magic link sent to <strong>{status.email}</strong>. Check your inbox.
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="text-sm">
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-700 px-3 py-2 bg-transparent"
          placeholder="you@team.com"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 py-2 font-medium disabled:opacity-50"
      >
        {pending ? "Sending…" : "Send magic link"}
      </button>
      {status.kind === "error" && (
        <p className="text-sm text-red-600">{status.message}</p>
      )}
    </form>
  );
}
