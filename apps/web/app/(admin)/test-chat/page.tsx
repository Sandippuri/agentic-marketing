import { redirect } from "next/navigation";
import { getSupabaseServer } from "@/lib/supabase/server";
import { lookupAdminRole } from "@/lib/billing/admin";
import { ChatClient } from "./chat-client";
import { Badge } from "../ui";

export const dynamic = "force-dynamic";

export default async function TestChatPage() {
  const sb = await getSupabaseServer();
  const { data: userData } = await sb.auth.getUser();
  if (!userData.user) redirect("/login?next=/test-chat");
  const isSuperadmin =
    (await lookupAdminRole(userData.user.id)) === "superadmin";

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
        <ChatClient />
      </div>
    </div>
  );
}
