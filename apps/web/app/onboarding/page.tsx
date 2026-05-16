import { redirect } from "next/navigation";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getWorkspaceContext } from "@/lib/billing";
import { lookupAdminRole } from "@/lib/billing/admin";
import { OnboardingWizard, type ExistingBrandDoc } from "./wizard";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const sb = await getSupabaseServer();
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) redirect("/login?next=/onboarding");

  const role = await lookupAdminRole(data.user.id);
  if (role === "superadmin") redirect("/super");

  const { workspaceId } = await getWorkspaceContext();
  const db = getDb();

  const [memoryRows, docRows] = await Promise.all([
    db
      .select({ id: schema.brandMemory.id })
      .from(schema.brandMemory)
      .where(eq(schema.brandMemory.workspaceId, workspaceId)),
    db
      .select({
        id: schema.brandDocuments.id,
        filename: schema.brandDocuments.filename,
        mimeType: schema.brandDocuments.mimeType,
        sizeBytes: schema.brandDocuments.sizeBytes,
        status: schema.brandDocuments.status,
        pageCount: schema.brandDocuments.pageCount,
        uploadedAt: schema.brandDocuments.uploadedAt,
      })
      .from(schema.brandDocuments)
      .where(
        and(
          eq(schema.brandDocuments.workspaceId, workspaceId),
          isNull(schema.brandDocuments.removedAt),
        ),
      )
      .orderBy(desc(schema.brandDocuments.uploadedAt)),
  ]);

  // Already onboarded — bounce to the workspace home. Brand memory is the
  // canonical signal: if even one slug exists, the wizard's job is done.
  if (memoryRows.length > 0) redirect("/campaigns");

  const initialDocs: ExistingBrandDoc[] = docRows.map((r) => ({
    id: r.id,
    filename: r.filename,
    mimeType: r.mimeType,
    sizeBytes: Number(r.sizeBytes),
    status: r.status,
    pageCount: r.pageCount,
    uploadedAt: r.uploadedAt.toISOString(),
  }));

  return (
    <OnboardingWizard
      workspaceId={workspaceId}
      userEmail={data.user.email ?? null}
      initialDocs={initialDocs}
    />
  );
}
