import { ChatClient } from "./chat-client";
import { Badge } from "../ui";

export const dynamic = "force-dynamic";

export default function TestChatPage() {
  return (
    <div className="h-[calc(100dvh-7rem)] flex flex-col">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">Test chat</h1>
          <p className="mt-1 text-sm text-mid max-w-2xl">
            Drives the agent end-to-end. Publish jobs run in test mode — no real social or email posting.
          </p>
        </div>
        <Badge tone="warn" dot>
          test mode
        </Badge>
      </header>
      <div className="flex-1 min-h-0 surface overflow-hidden flex flex-col">
        <ChatClient />
      </div>
    </div>
  );
}
