// Verifies the Phase 1 invariant end-to-end.
//   1. Insert a campaign + a draft content_item.
//   2. Try to insert a publish_jobs row -> must fail with check_violation.
//   3. Flip content -> approved, retry -> must succeed.
//   4. Cleanup.
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });

const out = (label, ok, extra) =>
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? `  (${extra})` : ""}`);

let passed = true;
try {
  await sql.begin(async (tx) => {
    const [campaign] = await tx`
      insert into campaigns (slug, name)
      values ('publish-gate-probe', 'Publish-gate probe')
      returning id
    `;
    const [content] = await tx`
      insert into content_items (campaign_id, type, title)
      values (${campaign.id}, 'blog', 'Probe')
      returning id, status
    `;
    out(`content created in status=${content.status}`, content.status === "draft");

    let firstAttemptError = null;
    try {
      // Wrap in a savepoint so the trigger error doesn't abort the parent tx.
      await tx.savepoint(async (sp) => {
        await sp`
          insert into publish_jobs (content_id, channel)
          values (${content.id}, 'internal_blog')
        `;
      });
    } catch (err) {
      firstAttemptError = err;
    }
    const trippedTrigger =
      firstAttemptError && /must be approved/.test(firstAttemptError.message);
    out(
      "publish_jobs insert blocked while content is draft",
      trippedTrigger,
      firstAttemptError?.message?.slice(0, 80),
    );
    if (!trippedTrigger) passed = false;

    await tx`
      update content_items set status = 'approved' where id = ${content.id}
    `;
    let secondAttemptOk = false;
    try {
      const [job] = await tx`
        insert into publish_jobs (content_id, channel)
        values (${content.id}, 'internal_blog')
        returning id, status
      `;
      secondAttemptOk = !!job?.id && job.status === "queued";
    } catch (err) {
      out("publish_jobs insert after approve unexpectedly failed", false, err.message);
    }
    out("publish_jobs insert succeeds once content is approved", secondAttemptOk);
    if (!secondAttemptOk) passed = false;

    // Roll back the whole probe — leave the DB clean.
    throw new Error("__rollback__");
  });
} catch (err) {
  if (err.message !== "__rollback__") {
    console.error("probe error:", err.message);
    passed = false;
  }
}

const [{ count: cCount }] = await sql`select count(*)::int from campaigns`;
const [{ count: pCount }] = await sql`select count(*)::int from publish_jobs`;
out(`cleanup ok (campaigns=${cCount}, publish_jobs=${pCount})`, cCount === 0 && pCount === 0);

await sql.end();
process.exit(passed ? 0 : 1);
