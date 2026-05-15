import { ZodError, type ZodSchema } from "zod";
import { InvalidTransitionError } from "./state-machine";
import { InternalAuthError } from "./internal-auth";
import { UnauthorizedError } from "./auth";
import {
  EntitlementError,
  NotWorkspaceMemberError,
  QuotaExceededError,
  SuperadminRequiredError,
  WorkspaceNotFoundError,
} from "./billing/errors";

// Single error-mapping point for Route Handlers.
export function errorResponse(err: unknown): Response {
  if (err instanceof ZodError) {
    return Response.json({ error: "validation", issues: err.issues }, { status: 400 });
  }
  if (err instanceof InvalidTransitionError) {
    return Response.json(
      { error: "invalid_transition", entity: err.entity, from: err.from, to: err.to },
      { status: 409 },
    );
  }
  if (err instanceof UnauthorizedError) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (err instanceof InternalAuthError) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (err instanceof SuperadminRequiredError) {
    return Response.json({ error: "superadmin_required" }, { status: 403 });
  }
  if (err instanceof NotWorkspaceMemberError) {
    return Response.json({ error: "not_workspace_member" }, { status: 403 });
  }
  if (err instanceof WorkspaceNotFoundError) {
    return Response.json({ error: "workspace_not_found" }, { status: 404 });
  }
  if (err instanceof EntitlementError) {
    return Response.json(
      { error: "feature_not_available", feature: err.feature, plan: err.plan },
      { status: 402 },
    );
  }
  if (err instanceof QuotaExceededError) {
    return Response.json(
      {
        error: "quota_exceeded",
        metric: err.metric,
        limit: err.limit,
        used: err.used,
        plan: err.plan,
      },
      { status: 429, headers: { "x-billing-quota": err.metric } },
    );
  }
  if (err instanceof PublishGateError) {
    return Response.json({ error: "publish_gate", reason: err.message }, { status: 409 });
  }
  if (err instanceof LlmPreflightError) {
    return Response.json(
      {
        error: "llm_preflight_failed",
        provider: err.provider,
        model: err.model,
        reason: err.kind,
        message: err.message,
      },
      { status: 503 },
    );
  }
  console.error("[api] unhandled", err);
  return Response.json({ error: "internal" }, { status: 500 });
}

export class PublishGateError extends Error {}

// Thrown by the dispatcher when the chosen LLM fails a 1-token preflight
// (quota exhausted / bad key / provider down). Surfaces as 503 so the UI
// can show a clear "switch model or top up" message instead of waiting
// for a workflow to fail mid-flight.
export class LlmPreflightError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly kind: "quota" | "auth" | "other";
  constructor(args: {
    provider: string;
    model: string;
    kind: "quota" | "auth" | "other";
    message: string;
  }) {
    super(args.message);
    this.name = "LlmPreflightError";
    this.provider = args.provider;
    this.model = args.model;
    this.kind = args.kind;
  }
}

export async function parseJson<T>(
  request: Request,
  schema: ZodSchema<T>,
): Promise<T> {
  const raw = await request.json().catch(() => ({}));
  return schema.parse(raw);
}
