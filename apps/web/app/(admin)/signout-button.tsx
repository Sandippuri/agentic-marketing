"use client";

import { useState } from "react";

export function SignoutButton() {
  const [pending, setPending] = useState(false);
  return (
    <form
      action="/auth/signout"
      method="post"
      onSubmit={() => setPending(true)}
    >
      <button
        type="submit"
        disabled={pending}
        className="text-faint hover:text-ink transition-colors disabled:opacity-50"
        title="Sign out"
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
    </form>
  );
}
