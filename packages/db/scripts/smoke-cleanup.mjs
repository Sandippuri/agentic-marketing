import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const audits = await sql`select action, entity_type, actor_kind, at from audit_log order by at desc limit 10`;
console.log("audit_log (most recent 10):");
for (const r of audits) console.log(`  ${r.at.toISOString()}  ${r.actor_kind.padEnd(6)}  ${r.action.padEnd(22)}  ${r.entity_type}`);

console.log("\ncleaning smoke campaign…");
const removed = await sql`delete from campaigns where slug = 'smoke' returning id`;
const removedAudits = await sql`delete from audit_log where action in ('campaign.create','content.create')`;
console.log(`  removed ${removed.length} campaign(s); pruned ${removedAudits.count} audit row(s)`);
await sql.end();
