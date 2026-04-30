import { ZodError, type ZodSchema } from "zod";
import { InvalidTransitionError } from "./state-machine";
import { InternalAuthError } from "./internal-auth";
import { UnauthorizedError } from "./auth";

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
  if (err instanceof PublishGateError) {
    return Response.json({ error: "publish_gate", reason: err.message }, { status: 409 });
  }
  console.error("[api] unhandled", err);
  return Response.json({ error: "internal" }, { status: 500 });
}

export class PublishGateError extends Error {}

export async function parseJson<T>(
  request: Request,
  schema: ZodSchema<T>,
): Promise<T> {
  const raw = await request.json().catch(() => ({}));
  return schema.parse(raw);
}
