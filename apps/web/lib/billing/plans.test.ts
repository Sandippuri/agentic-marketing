// Plan cache should fall back to DEFAULT_PLANS when the DB is unreachable,
// so the app can boot in CI / unit-test environments that don't seed the
// `plans` table.

import { describe, expect, it, beforeEach } from "vitest";
import { _resetPlanCache, getPlanByCode, getPlanById, listPublicPlans } from "./plans";
import { PLAN_IDS } from "@marketing/shared-types";

beforeEach(() => {
  _resetPlanCache();
  // Make sure the postgres client tries to connect to a dead URL so we
  // exercise the catch-block fallback.
  process.env.DATABASE_URL = "postgres://nope:nope@127.0.0.1:1/nope";
});

describe("billing/plans fallback", () => {
  it("returns the typed default for a known code", async () => {
    const free = await getPlanByCode("free");
    expect(free.code).toBe("free");
    expect(free.id).toBe(PLAN_IDS.free);
    expect(free.quotas.seats).toBe(1);
  });

  it("returns the typed default for a known id", async () => {
    const growth = await getPlanById(PLAN_IDS.growth);
    expect(growth.code).toBe("growth");
    expect(growth.features.asset_pipeline).toBe(true);
  });

  it("returns the free plan when id is unknown", async () => {
    const ghost = await getPlanById("00000000-0000-0000-0000-deadbeefdead");
    expect(ghost.code).toBe("free");
  });

  it("lists only public plans sorted by sortOrder", async () => {
    const list = await listPublicPlans();
    expect(list.map((p) => p.code)).toEqual(["free", "starter", "growth", "business"]);
    expect(list.every((p) => p.isPublic)).toBe(true);
  });
});
