"use client";

import { useState, useTransition } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";

type Mode = "password" | "magic";

type Status =
  | { kind: "idle" }
  | { kind: "sent"; email: string }
  | { kind: "error"; message: string };

export function LoginForm({ next, error }: { next: string; error?: string }) {
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>(
    error ? { kind: "error", message: error } : { kind: "idle" },
  );
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const supabase = getSupabaseBrowser();
      if (mode === "password") {
        const { error: err } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (err) {
          setStatus({ kind: "error", message: err.message });
          return;
        }
        // Bounce through /auth/post-signin so the same allowlist +
        // workspace-provisioning gate the magic-link path uses runs here too.
        window.location.href = `/auth/post-signin?next=${encodeURIComponent(next)}`;
        return;
      }
      // Magic link path. /auth/callback exchanges the OTP for a session
      // cookie, then redirects to `next`.
      const { error: err } = await supabase.auth.signInWithOtp({
        email,
        options: {
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
          autoComplete="email"
        />
      </label>

      {mode === "password" && (
        <label className="text-sm">
          Password
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-700 px-3 py-2 bg-transparent"
            placeholder="••••••••"
            autoComplete="current-password"
          />
        </label>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 py-2 font-medium disabled:opacity-50"
      >
        {pending
          ? mode === "password"
            ? "Signing in…"
            : "Sending…"
          : mode === "password"
            ? "Sign in"
            : "Send magic link"}
      </button>

      <button
        type="button"
        onClick={() => {
          setStatus({ kind: "idle" });
          setMode((m) => (m === "password" ? "magic" : "password"));
        }}
        className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 self-start"
      >
        {mode === "password"
          ? "Use a magic link instead →"
          : "← Use password instead"}
      </button>

      {status.kind === "error" && (
        <p className="text-sm text-red-600">{status.message}</p>
      )}
    </form>
  );
}
