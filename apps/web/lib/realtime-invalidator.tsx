"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createBrowserClient } from "@supabase/ssr";

/**
 * Subscribes to Supabase Realtime Postgres-changes for the three hot tables
 * (content_items, approvals, publish_jobs) and invalidates the matching
 * TanStack Query keys on every event.
 *
 * Mount once in the admin layout — keeps the approval queue, campaign detail,
 * and publish-job list live without polling.
 */
export function RealtimeInvalidator() {
  const queryClient = useQueryClient();

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
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return null;
}
