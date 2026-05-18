import { redirect } from "next/navigation";
import { getSupabaseServer } from "@/lib/supabase/server";
import { lookupAdminRole } from "@/lib/billing/admin";
import { getWorkspaceContext } from "@/lib/billing";
import { ChatClient } from "./chat-client";
import { Badge } from "../ui";

export const dynamic = "force-dynamic";

function deriveDisplayName(user: {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}): string | null {
  const meta = user.user_metadata ?? {};
  const fromMeta =
    pickString(meta.full_name) ??
    pickString(meta.name) ??
    pickString(meta.display_name) ??
    pickString(meta.preferred_name);
  if (fromMeta) return fromMeta;
  const email = user.email ?? null;
  if (!email) return null;
  // Local-part fallback. Strip dots/underscores so "jane.doe" reads "jane doe"
  // and gets capitalized on each token.
  const local = email.split("@")[0] ?? "";
  if (!local) return null;
  return local
    .split(/[._-]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

function pickString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export default async function TestChatPage() {
  const sb = await getSupabaseServer();
  const { data: userData } = await sb.auth.getUser();
  if (!userData.user) redirect("/login?next=/test-chat");
  const isSuperadmin =
    (await lookupAdminRole(userData.user.id)) === "superadmin";

  const displayName = deriveDisplayName(userData.user);
  // Workspace lookup is best-effort — a brand-new user without a workspace
  // shouldn't crash the chat page, just lose the pill.
  const workspaceName = await getWorkspaceContext()
    .then((ctx) => ctx.workspaceName)
    .catch(() => null);

  return (
    <div className="h-[calc(100dvh-7rem)] flex flex-col">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">
            Assistant
          </h1>
          <p className="mt-1 text-sm text-mid max-w-2xl">
            Ask about your campaigns, posts, brand, or kick off a new draft.
            The assistant has read access to this workspace and can run the
            full content pipeline.
          </p>
        </div>
        {isSuperadmin && (
          <Badge tone="warn" dot>
            test mode
          </Badge>
        )}
      </header>
      <div className="flex-1 min-h-0 surface overflow-hidden flex flex-col">
        <ChatClient displayName={displayName} workspaceName={workspaceName} />
      </div>
    </div>
  );
}
