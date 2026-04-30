// End-to-end publish smoke test:
//   1. create campaign + content via API
//   2. flip content -> approved via DB (skips the manual approval flow)
//   3. POST /api/publish-jobs (which enqueues to BullMQ)
//   4. poll publish_jobs until status='succeeded' (Distributor processed it)
//   5. fetch /api/content/:id and verify status='published' + URL
//   6. clean up
import postgres from "postgres";

const baseUrl = process.env.CP_BASE_URL ?? "http://localhost:3000";
const token = process.env.INTERNAL_API_TOKEN;
if (!token) throw new Error("INTERNAL_API_TOKEN required");

const slug = `smoke-${Date.now().toString(36)}`;

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-internal-token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return parsed;
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });

let campaignId, contentId, jobId;
try {
  const campaign = await call("POST", "/api/campaigns", {
    slug,
    name: "E2E publish smoke",
  });
  campaignId = campaign.id;
  console.log(`✓ campaign ${campaignId}`);

  const content = await call("POST", "/api/content", {
    campaignId,
    type: "blog",
    title: "Hello from the publish loop",
    bodyMd: "Published end-to-end via the Distributor.",
  });
  contentId = content.id;
  console.log(`✓ content ${contentId} (status=${content.status})`);

  await sql`update content_items set status='approved' where id=${contentId}`;
  console.log(`✓ flipped to approved`);

  const job = await call("POST", "/api/publish-jobs", {
    contentId,
    channel: "internal_blog",
  });
  jobId = job.id;
  console.log(
    `✓ publish_job ${jobId} (status=${job.status}, enqueue=${JSON.stringify(job.enqueue)})`,
  );

  // Poll for completion. Distributor should pick it up immediately via BullMQ.
  const deadline = Date.now() + 15_000;
  let final;
  while (Date.now() < deadline) {
    const fresh = await call("GET", `/api/publish-jobs/${jobId}`);
    if (fresh.status === "succeeded" || fresh.status === "failed") {
      final = fresh;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!final) throw new Error("timed out waiting for distributor");
  console.log(
    `✓ distributor finished: status=${final.status}, externalUrl=${final.externalUrl}`,
  );
  if (final.status !== "succeeded") {
    throw new Error(`expected succeeded, got ${final.status}: ${final.error}`);
  }

  const finalContent = await call("GET", `/api/content/${contentId}`);
  console.log(
    `✓ content state: status=${finalContent.status}, publishedUrl=${finalContent.publishedUrl}`,
  );
  if (finalContent.status !== "published" || !finalContent.publishedUrl?.startsWith("/blog/")) {
    throw new Error(`content not published correctly: ${JSON.stringify(finalContent)}`);
  }

  // Render the public blog page (no auth needed).
  const blogRes = await fetch(`${baseUrl}${finalContent.publishedUrl}`);
  const blogText = await blogRes.text();
  const titleMatched = blogText.includes("Hello from the publish loop");
  console.log(
    `✓ /blog page returned ${blogRes.status}, title rendered=${titleMatched}`,
  );

  console.log("\nALL CHECKS PASSED 🌊");
} catch (err) {
  console.error("\n✗ smoke failed:", err.message);
  process.exitCode = 1;
} finally {
  if (campaignId) {
    await sql`delete from audit_log where entity_id in (
      select id from content_items where campaign_id=${campaignId}
    ) or entity_id=${campaignId}`;
    await sql`delete from campaigns where id=${campaignId}`;
    console.log("✓ cleaned up");
  }
  await sql.end();
}
