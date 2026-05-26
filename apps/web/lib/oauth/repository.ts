import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import type { SocialProvider } from "@marketing/shared-types";
import { decryptToken, encryptToken } from "./encryption";

// All access to the `social_connections` table goes through here so the
// encryption boundary is in one place.

export type StoredConnection = {
  id: string;
  workspaceId: string;
  provider: SocialProvider;
  accountId: string;
  accountLabel: string;
  scopes: string[];
  metadata: Record<string, unknown>;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastRefreshedAt: Date | null;
};

export type ConnectionWithTokens = StoredConnection & {
  accessToken: string;
  refreshToken: string | null;
};

export type UpsertConnectionInput = {
  workspaceId: string;
  provider: SocialProvider;
  accountId: string;
  accountLabel: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scopes?: string[];
  metadata?: Record<string, unknown>;
};

function rowToStored(
  r: typeof schema.socialConnections.$inferSelect,
): StoredConnection {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    provider: r.provider,
    accountId: r.accountId,
    accountLabel: r.accountLabel,
    scopes: r.scopes ?? [],
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastRefreshedAt: r.lastRefreshedAt,
  };
}

export async function listConnections(
  workspaceId: string,
): Promise<StoredConnection[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.socialConnections)
    .where(eq(schema.socialConnections.workspaceId, workspaceId));
  return rows.map(rowToStored);
}

export async function getConnection(
  workspaceId: string,
  provider: SocialProvider,
): Promise<ConnectionWithTokens | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.socialConnections)
    .where(
      and(
        eq(schema.socialConnections.workspaceId, workspaceId),
        eq(schema.socialConnections.provider, provider),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    ...rowToStored(row),
    accessToken: decryptToken(row.accessTokenEnc),
    refreshToken: row.refreshTokenEnc ? decryptToken(row.refreshTokenEnc) : null,
  };
}

export async function upsertConnection(
  input: UpsertConnectionInput,
): Promise<StoredConnection> {
  const db = getDb();
  const now = new Date();
  const values = {
    workspaceId: input.workspaceId,
    provider: input.provider,
    accountId: input.accountId,
    accountLabel: input.accountLabel,
    accessTokenEnc: encryptToken(input.accessToken),
    refreshTokenEnc: input.refreshToken ? encryptToken(input.refreshToken) : null,
    expiresAt: input.expiresAt ?? null,
    scopes: input.scopes ?? [],
    metadata: input.metadata ?? {},
    updatedAt: now,
    lastRefreshedAt: now,
  };
  const rows = await db
    .insert(schema.socialConnections)
    .values(values)
    .onConflictDoUpdate({
      target: [
        schema.socialConnections.workspaceId,
        schema.socialConnections.provider,
      ],
      set: {
        accountId: values.accountId,
        accountLabel: values.accountLabel,
        accessTokenEnc: values.accessTokenEnc,
        refreshTokenEnc: values.refreshTokenEnc,
        expiresAt: values.expiresAt,
        scopes: values.scopes,
        metadata: values.metadata,
        updatedAt: values.updatedAt,
        lastRefreshedAt: values.lastRefreshedAt,
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("upsertConnection returned no row");
  return rowToStored(row);
}

export async function deleteConnection(
  workspaceId: string,
  provider: SocialProvider,
): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.socialConnections)
    .where(
      and(
        eq(schema.socialConnections.workspaceId, workspaceId),
        eq(schema.socialConnections.provider, provider),
      ),
    );
}
