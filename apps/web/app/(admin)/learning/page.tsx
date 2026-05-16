import Link from "next/link";
import { redirect } from "next/navigation";
import { aggregateLearningSignal } from "@/lib/learning/aggregate";
import { listDocuments, getCollectionBySlug } from "@marketing/agents/kb";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getWorkspaceContext } from "@/lib/billing";
import { PageHeader } from "../ui";
import { LearningClient } from "./client";

export const dynamic = "force-dynamic";

export default async function LearningPage({
  searchParams,
}: {
  searchParams: Promise<{ windowDays?: string }>;
}) {
  const sb = await getSupabaseServer();
  const { data: userData } = await sb.auth.getUser();
  if (!userData.user) redirect("/login?next=/learning");

  const { workspaceId } = await getWorkspaceContext();
  const params = await searchParams;
  const windowDays = Math.min(
    365,
    Math.max(1, Number(params.windowDays ?? "30") || 30),
  );
  const summary = await aggregateLearningSignal({
    workspaceId,
    windowDays,
    limit: 10,
  });

  const lessons = await loadLatestLessons(workspaceId);

  return (
    <>
      <PageHeader
        title="Learning loop"
        description="What the AI's drafts get right and wrong over time. The content sub-agent reads the synthesised playbook below before every run via findCommonMistakes / kb_search."
      />
      <LearningClient
        windowDays={windowDays}
        summary={summary}
        lessons={lessons}
      />
    </>
  );
}

async function loadLatestLessons(workspaceId: string) {
  const collection = await getCollectionBySlug(workspaceId, "learning-loop");
  if (!collection) return null;
  const docs = await listDocuments({
    workspaceId,
    collectionId: collection.id,
    status: "active",
    limit: 1,
  });
  if (docs.length === 0) return null;
  const doc = docs[0]!;
  return {
    id: doc.id,
    slug: doc.slug,
    title: doc.title,
    body: doc.bodyMd,
    updatedAt: doc.updatedAt.toISOString(),
  };
}
