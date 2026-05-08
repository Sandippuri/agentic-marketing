import Link from "next/link";
import { aggregateLearningSignal } from "@/lib/learning/aggregate";
import { listDocuments, getCollectionBySlug } from "@marketing/agents/kb";
import { PageHeader } from "../ui";
import { LearningClient } from "./client";

export const dynamic = "force-dynamic";

export default async function LearningPage({
  searchParams,
}: {
  searchParams: Promise<{ windowDays?: string }>;
}) {
  const params = await searchParams;
  const windowDays = Math.min(
    365,
    Math.max(1, Number(params.windowDays ?? "30") || 30),
  );
  const summary = await aggregateLearningSignal({ windowDays, limit: 10 });

  const lessons = await loadLatestLessons();

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

async function loadLatestLessons() {
  const collection = await getCollectionBySlug("learning-loop");
  if (!collection) return null;
  const docs = await listDocuments({
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
