// Cross-tenant isolation guard. These tests assert that the filter
// builders produce the expected SQL conditions — the actual cross-tenant
// query test lives in a DB-backed integration suite (gated on
// DATABASE_URL, runs in CI only against a throwaway Postgres).
//
// Why a unit test? The risk we're guarding against is "a route forgets
// to call whereInWorkspace." Code review and the PR 9 RLS backstop
// catch that. What we need to lock down here is "whereInWorkspace, when
// invoked, actually emits the workspace_id predicate." A schema/grammar
// regression in Drizzle could silently drop the filter.

import { describe, expect, it } from "vitest";
import { schema } from "@marketing/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import { workspaceWhere, whereInWorkspace } from "./scoped-db";
import type { WorkspaceContext } from "./workspace-context";

const dialect = new PgDialect();

function makeCtx(workspaceId: string): WorkspaceContext {
  return {
    userId: "user-x",
    email: "x@example.com",
    workspaceId,
    workspaceSlug: "w",
    workspaceName: "W",
    role: "owner",
    isOwner: true,
    plan: {} as WorkspaceContext["plan"],
  };
}

// Compile a Drizzle SQL fragment to a stable string for assertion.
function compile(sql: ReturnType<typeof eq> | undefined): string {
  if (!sql) return "";
  const { sql: text, params } = dialect.sqlToQuery(sql);
  return `${text} :: ${JSON.stringify(params)}`;
}

describe("billing/scoped-db", () => {
  it("workspaceWhere returns undefined for a null context (internal callers)", () => {
    expect(workspaceWhere(schema.campaigns, null)).toBeUndefined();
  });

  it("workspaceWhere compiles to a workspace_id equality predicate", () => {
    const sql = workspaceWhere(schema.campaigns, makeCtx("ws-1"));
    const compiled = compile(sql);
    expect(compiled).toContain("workspace_id");
    expect(compiled).toContain("ws-1");
  });

  it("whereInWorkspace ANDs the workspace filter with extras and drops undefined", () => {
    const sql = whereInWorkspace(
      schema.campaigns,
      makeCtx("ws-1"),
      eq(schema.campaigns.status, "active"),
      undefined,
      eq(schema.campaigns.phase, "launch"),
    );
    const compiled = compile(sql);
    expect(compiled).toContain("workspace_id");
    expect(compiled).toContain("status");
    expect(compiled).toContain("phase");
    // Trailing `undefined` slot didn't leak into the SQL.
    expect(compiled).not.toContain("undefined");
  });

  it("whereInWorkspace with no extras still scopes by workspace", () => {
    const compiled = compile(
      whereInWorkspace(schema.campaigns, makeCtx("ws-2")),
    );
    expect(compiled).toContain("workspace_id");
    expect(compiled).toContain("ws-2");
  });

  it("whereInWorkspace with null ctx and no extras returns undefined", () => {
    expect(whereInWorkspace(schema.campaigns, null)).toBeUndefined();
  });

  it("whereInWorkspace with null ctx but some extras keeps only the extras", () => {
    const compiled = compile(
      whereInWorkspace(
        schema.campaigns,
        null,
        eq(schema.campaigns.status, "active"),
      ),
    );
    expect(compiled).toContain("status");
    expect(compiled).not.toContain("workspace_id");
  });
});
