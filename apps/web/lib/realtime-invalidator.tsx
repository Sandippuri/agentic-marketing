"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { createBrowserClient } from "@supabase/ssr";

/**
 * Subscribes to Supabase Realtime Postgres-changes on hot tables and invalidates
 * matching TanStack Query keys. Also calls `router.refresh()` when `outcomes`
 * changes so SSR pages like `/insights` (Server Components) pick up rollup data.
 *
 * Mount once in the admin layout — keeps the approval queue, campaign lists,
 * and publish-job surfaces live without polling.
 */
export function RealtimeInvalidator() {
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    const channel = supabase
      .channel("admin-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "content_items" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["campaigns"] });
          queryClient.invalidateQueries({ queryKey: ["content"] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "approvals" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["approvals"] });
          queryClient.invalidateQueries({ queryKey: ["campaigns"] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "publish_jobs" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["publish-jobs"] });
          queryClient.invalidateQueries({ queryKey: ["campaigns"] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "outcomes" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["insights"] });
          router.refresh();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, router]);

  return null;
}
