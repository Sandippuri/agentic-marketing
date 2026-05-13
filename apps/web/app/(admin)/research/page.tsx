import Link from "next/link";
import { getResearchStore } from "@/lib/research-store";
import { PageHeader } from "../ui";
import { ResearchView } from "./research-view";

export const dynamic = "force-dynamic";

export default async function ResearchPage() {
  const report = await getResearchStore().getLatest();

  return (
    <>
      <PageHeader
        title="Research"
        description={
          <>
            Latest daily news scan from the Researcher. Configure keywords and
            search provider in{" "}
            <Link className="underline hover:text-ink" href="/settings">
              Settings → Research
            </Link>
            . Per-keyword findings also land in the Knowledge Base under the{" "}
            <Link className="underline hover:text-ink" href="/knowledge">
              daily-news
            </Link>{" "}
            collection.
          </>
        }
      />
      <ResearchView report={report} />
    </>
  );
}
