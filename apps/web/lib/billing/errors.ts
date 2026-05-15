// Entitlement / billing error types.
//
// These extend Error so they survive Drizzle / Supabase / fetch error
// propagation. errorResponse() in lib/http.ts maps them to HTTP responses.

import type { Feature, Quota } from "@marketing/shared-types";

export class EntitlementError extends Error {
  readonly feature: Feature;
  readonly plan: string;
  constructor(args: { feature: Feature; plan: string; message?: string }) {
    super(args.message ?? `feature_not_available:${args.feature}`);
    this.name = "EntitlementError";
    this.feature = args.feature;
    this.plan = args.plan;
  }
}

export class QuotaExceededError extends Error {
  readonly metric: Quota;
  readonly limit: number;
  readonly used: number;
  readonly plan: string;
  constructor(args: {
    metric: Quota;
    limit: number;
    used: number;
    plan: string;
    message?: string;
  }) {
    super(args.message ?? `quota_exceeded:${args.metric}`);
    this.name = "QuotaExceededError";
    this.metric = args.metric;
    this.limit = args.limit;
    this.used = args.used;
    this.plan = args.plan;
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor(message = "workspace_not_found") {
    super(message);
    this.name = "WorkspaceNotFoundError";
  }
}

export class NotWorkspaceMemberError extends Error {
  constructor(message = "not_a_workspace_member") {
    super(message);
    this.name = "NotWorkspaceMemberError";
  }
}

export class SuperadminRequiredError extends Error {
  constructor(message = "superadmin_required") {
    super(message);
    this.name = "SuperadminRequiredError";
  }
}
