"use client";

import { useState, useTransition } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";

type Mode = "password" | "magic";

type Status =
  | { kind: "idle" }
  | { kind: "sent"; email: string }
  | { kind: "error"; message: string };

const ERROR_COPY: Record<string, string> = {
  not_on_allowlist:
    "This email isn't on the access list. Ask an admin to add you.",
  missing_code: "Sign-in link is missing a code. Request a new one.",
  no_user: "Couldn't load your account. Try signing in again.",
  no_session: "Your session expired. Sign in again.",
};

function friendlyError(message: string): string {
  return ERROR_COPY[message] ?? message;
}

export function LoginForm({ next, error }: { next: string; error?: string }) {
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
        window.location.href = `/auth/post-signin?next=${encodeURIComponent(next)}`;
        return;
      }
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
      <div className="surface p-4 text-sm text-mid">
        Magic link sent to{" "}
        <strong className="text-ink">{status.email}</strong>. Check your inbox.
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm text-ink">
        <span className="text-xs font-medium uppercase tracking-wider text-mid">
          Email
        </span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-border bg-surface-2 px-3 py-2.5 text-[14px] text-ink placeholder:text-faint focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-ring)] transition-colors"
          placeholder="you@team.com"
          autoComplete="email"
        />
      </label>

      {mode === "password" && (
        <label className="flex flex-col gap-1.5 text-sm text-ink">
          <span className="flex items-center justify-between text-xs font-medium uppercase tracking-wider text-mid">
            Password
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              className="text-[11px] normal-case tracking-normal text-faint hover:text-ink transition-colors"
              tabIndex={-1}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </span>
          <input
            type={showPassword ? "text" : "password"}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-border bg-surface-2 px-3 py-2.5 text-[14px] text-ink placeholder:text-faint focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-ring)] transition-colors"
            placeholder="Your password"
            autoComplete="current-password"
          />
        </label>
      )}

      <button
        type="submit"
        disabled={pending || !email || (mode === "password" && !password)}
        className="btn btn-primary mt-1 justify-center py-2.5 text-sm"
      >
        {pending
          ? mode === "password"
            ? "Signing in…"
            : "Sending magic link…"
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
        className="text-xs text-mid hover:text-ink self-start transition-colors"
      >
        {mode === "password"
          ? "Use a magic link instead →"
          : "← Use password instead"}
      </button>

      {status.kind === "error" && (
        <div
          role="alert"
          className="rounded-md border border-danger bg-(--danger-soft) px-3 py-2 text-sm text-danger"
        >
          {friendlyError(status.message)}
        </div>
      )}
    </form>
  );
}
