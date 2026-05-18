"use client";

import dynamic from "next/dynamic";

// next/dynamic with ssr: false skips server prerender entirely so the client
// component can use localStorage / EventSource at first render without a
// hydration mismatch.
const ChatClientReady = dynamic(() => import("./chat-client-ready"), {
  ssr: false,
});

export function ChatClient({
  displayName,
  workspaceName,
}: {
  displayName?: string | null;
  workspaceName?: string | null;
}) {
  return (
    <ChatClientReady
      displayName={displayName}
      workspaceName={workspaceName}
    />
  );
}
