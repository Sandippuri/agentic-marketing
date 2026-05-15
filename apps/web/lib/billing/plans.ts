// Plan catalog loader. Reads `plans` rows on first use and caches them by
// id and code for the lifetime of the process. Falls back to the typed
// DEFAULT_PLANS from @marketing/shared-types/billing when the row is missing
// (lets tests and migrations boot without a seeded DB).
//
// Plan changes during a process's lifetime require a redeploy — that's fine,
// the catalog is small and write-rare. If we ever need hot-reload we'll add
// a TTL or pubsub invalidation here.

import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import {
  DEFAULT_PLANS,
  PLAN_IDS,
  findDefaultPlan,
  type FeatureSet,
  type PlanCode,
  type PlanDefinition,
  type QuotaSet,
} from "@marketing/shared-types";

export type LoadedPlan = PlanDefinition & {
  id: string;
};

let cacheById: Map<string, LoadedPlan> | null = null;
let cacheByCode: Map<PlanCode, LoadedPlan> | null = null;

function rowToPlan(row: typeof schema.plans.$inferSelect): LoadedPlan {
  // jsonb columns come back as `unknown`; trust the seed shape but fail
  // loudly if something is off (a wrong plan in prod is worse than a 500).
  const features = row.features as FeatureSet;
  const quotas = row.quotas as QuotaSet;
  if (!features || typeof features !== "object") {
    throw new Error(`plan ${row.code} has invalid features jsonb`);
  }
  if (!quotas || typeof quotas !== "object") {
    throw new Error(`plan ${row.code} has invalid quotas jsonb`);
  }
  return {
    id: row.id,
    code: row.code as PlanCode,
    name: row.name,
    description: row.description,
    priceMonthlyNpr: row.priceMonthlyNpr,
    priceYearlyNpr: row.priceYearlyNpr,
    priceMonthlyUsdCents: row.priceMonthlyUsdCents,
    priceYearlyUsdCents: row.priceYearlyUsdCents,
    isPublic: row.isPublic,
    sortOrder: row.sortOrder,
    features,
    quotas,
  };
}

function defToLoaded(def: PlanDefinition): LoadedPlan {
  return { ...def, id: PLAN_IDS[def.code] };
}

async function loadCache(): Promise<void> {
  if (cacheById && cacheByCode) return;
  const byId = new Map<string, LoadedPlan>();
  const byCode = new Map<PlanCode, LoadedPlan>();
  try {
    const rows = await getDb().select().from(schema.plans);
    for (const row of rows) {
      const plan = rowToPlan(row);
      byId.set(plan.id, plan);
      byCode.set(plan.code, plan);
    }
  } catch (err) {
    // DB unavailable (tests / migrations) — fall back to typed defaults.
    console.warn("[billing/plans] db lookup failed, falling back to defaults", err);
  }
  for (const def of DEFAULT_PLANS) {
    if (!byCode.has(def.code)) {
      const plan = defToLoaded(def);
      byId.set(plan.id, plan);
      byCode.set(plan.code, plan);
    }
  }
  cacheById = byId;
  cacheByCode = byCode;
}

export async function getPlanById(id: string): Promise<LoadedPlan> {
  await loadCache();
  const plan = cacheById!.get(id);
  if (plan) return plan;
  // Unknown id — treat as the Free plan to fail closed without crashing.
  console.warn(`[billing/plans] unknown plan id ${id}; falling back to free`);
  return defToLoaded(findDefaultPlan("free"));
}

export async function getPlanByCode(code: PlanCode): Promise<LoadedPlan> {
  await loadCache();
  const plan = cacheByCode!.get(code);
  if (plan) return plan;
  return defToLoaded(findDefaultPlan(code));
}

export async function listPublicPlans(): Promise<LoadedPlan[]> {
  await loadCache();
  return Array.from(cacheByCode!.values())
    .filter((p) => p.isPublic)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

// For tests.
export function _resetPlanCache(): void {
  cacheById = null;
  cacheByCode = null;
}
