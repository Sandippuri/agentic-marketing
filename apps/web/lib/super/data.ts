import { and, desc, eq, isNull, sql, inArray } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import type { WorkspaceRole, AdminRole, SubscriptionStatus } from "@marketing/shared-types";
import { listAllAuthUsers, getAuthUser, type AuthUser } from "@/lib/supabase/admin";

// All queries here are intentionally NON-tenant-scoped. /super/* is the only
// place in the app where cross-tenant reads are legitimate, so we use the
// raw `getDb()` client (not getScopedDb()) and never thread a workspaceId in.

export type PlatformOverview = {
  totals: {
    users: number;
    workspaces: number;
    activeSubscriptions: number;
    pendingInvites: number;
    superadmins: number;
  };
  recentSignups: AuthUser[];
  recentWorkspaces: Array<{
    id: string;
    name: string;
    slug: string;
    ownerUserId: string;
    ownerEmail: string | null;
    planCode: string;
    createdAt: Date;
    memberCount: number;
  }>;
};

export async function getPlatformOverview(): Promise<PlatformOverview> {
  const db = getDb();

  const [users, workspacesRows, activeSubsRows, pendingInvitesRows, superadminsRows] =
    await Promise.all([
      listAllAuthUsers(),
      db
        .select({
          id: schema.workspaces.id,
          name: schema.workspaces.name,
          slug: schema.workspaces.slug,
          ownerUserId: schema.workspaces.ownerUserId,
          planId: schema.workspaces.planId,
          createdAt: schema.workspaces.createdAt,
        })
        .from(schema.workspaces)
        .where(isNull(schema.workspaces.deletedAt))
        .orderBy(desc(schema.workspaces.createdAt))
        .limit(8),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.subscriptions)
        .where(
          inArray(schema.subscriptions.status, [
            "trialing",
            "active",
            "past_due",
            "grace",
          ] satisfies SubscriptionStatus[]),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.workspaceMembers)
        .where(isNull(schema.workspaceMembers.acceptedAt)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.role, "superadmin" satisfies AdminRole)),
    ]);

  const allWorkspacesCountRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.workspaces)
    .where(isNull(schema.workspaces.deletedAt));

  const planRows = await db
    .select({ id: schema.plans.id, code: schema.plans.code })
    .from(schema.plans);
  const planById = new Map(planRows.map((p) => [p.id, p.code as string]));

  const ownerById = new Map(users.map((u) => [u.id, u.email]));

  const memberCounts =
    workspacesRows.length === 0
      ? new Map<string, number>()
      : new Map(
          (
            await db
              .select({
                workspaceId: schema.workspaceMembers.workspaceId,
                n: sql<number>`count(*)::int`,
              })
              .from(schema.workspaceMembers)
              .where(
                and(
                  inArray(
                    schema.workspaceMembers.workspaceId,
                    workspacesRows.map((w) => w.id),
                  ),
                  sql`${schema.workspaceMembers.acceptedAt} is not null`,
                ),
              )
              .groupBy(schema.workspaceMembers.workspaceId)
          ).map((r) => [r.workspaceId, r.n]),
        );

  return {
    totals: {
      users: users.length,
      workspaces: allWorkspacesCountRows[0]?.count ?? 0,
      activeSubscriptions: activeSubsRows[0]?.count ?? 0,
      pendingInvites: pendingInvitesRows[0]?.count ?? 0,
      superadmins: superadminsRows[0]?.count ?? 0,
    },
    recentSignups: [...users]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 8),
    recentWorkspaces: workspacesRows.map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      ownerUserId: w.ownerUserId,
      ownerEmail: ownerById.get(w.ownerUserId) ?? null,
      planCode: planById.get(w.planId) ?? "—",
      createdAt: w.createdAt,
      memberCount: memberCounts.get(w.id) ?? 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export type SuperUserRow = {
  id: string;
  email: string;
  createdAt: string;
  lastSignInAt: string | null;
  workspaceCount: number;
  ownedCount: number;
  isSuperadmin: boolean;
};

export async function listSuperUsers(): Promise<SuperUserRow[]> {
  const db = getDb();
  const [users, memberRows, ownedRows, adminRows] = await Promise.all([
    listAllAuthUsers(),
    db
      .select({
        userId: schema.workspaceMembers.userId,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.workspaceMembers)
      .where(sql`${schema.workspaceMembers.userId} is not null`)
      .groupBy(schema.workspaceMembers.userId),
    db
      .select({
        ownerUserId: schema.workspaces.ownerUserId,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.workspaces)
      .where(isNull(schema.workspaces.deletedAt))
      .groupBy(schema.workspaces.ownerUserId),
    db.select({ userId: schema.adminUsers.userId }).from(schema.adminUsers),
  ]);

  const memberByUser = new Map(memberRows.map((r) => [r.userId as string, r.n]));
  const ownedByUser = new Map(ownedRows.map((r) => [r.ownerUserId, r.n]));
  const adminSet = new Set(adminRows.map((r) => r.userId));

  return users
    .map((u) => ({
      id: u.id,
      email: u.email,
      createdAt: u.createdAt,
      lastSignInAt: u.lastSignInAt,
      workspaceCount: memberByUser.get(u.id) ?? 0,
      ownedCount: ownedByUser.get(u.id) ?? 0,
      isSuperadmin: adminSet.has(u.id),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type SuperUserDetail = {
  user: AuthUser;
  isSuperadmin: boolean;
  adminRole: AdminRole | null;
  memberships: Array<{
    workspaceId: string;
    workspaceName: string;
    workspaceSlug: string;
    role: WorkspaceRole;
    isOwner: boolean;
    planCode: string;
    acceptedAt: Date | null;
    invitedAt: Date | null;
    workspaceCreatedAt: Date;
  }>;
};

export async function getSuperUserDetail(
  userId: string,
): Promise<SuperUserDetail | null> {
  const db = getDb();
  const user = await getAuthUser(userId);
  if (!user) return null;

  const [membershipRows, adminRows, planRows] = await Promise.all([
    db
      .select({
        workspaceId: schema.workspaces.id,
        workspaceName: schema.workspaces.name,
        workspaceSlug: schema.workspaces.slug,
        ownerUserId: schema.workspaces.ownerUserId,
        planId: schema.workspaces.planId,
        workspaceCreatedAt: schema.workspaces.createdAt,
        role: schema.workspaceMembers.role,
        acceptedAt: schema.workspaceMembers.acceptedAt,
        invitedAt: schema.workspaceMembers.invitedAt,
      })
      .from(schema.workspaceMembers)
      .innerJoin(
        schema.workspaces,
        eq(schema.workspaceMembers.workspaceId, schema.workspaces.id),
      )
      .where(
        and(
          eq(schema.workspaceMembers.userId, userId),
          isNull(schema.workspaces.deletedAt),
        ),
      )
      .orderBy(desc(schema.workspaces.createdAt)),
    db
      .select({ role: schema.adminUsers.role })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, userId))
      .limit(1),
    db.select({ id: schema.plans.id, code: schema.plans.code }).from(schema.plans),
  ]);

  const planById = new Map(planRows.map((p) => [p.id, p.code as string]));
  const adminRole = (adminRows[0]?.role ?? null) as AdminRole | null;

  return {
    user,
    isSuperadmin: adminRole === "superadmin",
    adminRole,
    memberships: membershipRows.map((m) => ({
      workspaceId: m.workspaceId,
      workspaceName: m.workspaceName,
      workspaceSlug: m.workspaceSlug,
      role: m.role,
      isOwner: m.ownerUserId === userId,
      planCode: planById.get(m.planId) ?? "—",
      acceptedAt: m.acceptedAt,
      invitedAt: m.invitedAt,
      workspaceCreatedAt: m.workspaceCreatedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export type SuperWorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  ownerEmail: string | null;
  planCode: string;
  planOverriddenUntil: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
  memberCount: number;
  pendingInviteCount: number;
  subscriptionStatus: SubscriptionStatus | null;
};

export async function listSuperWorkspaces(opts?: {
  includeDeleted?: boolean;
}): Promise<SuperWorkspaceRow[]> {
  const db = getDb();
  const includeDeleted = opts?.includeDeleted ?? false;

  const [rows, planRows, memberCountRows, pendingCountRows, latestSubs, users] =
    await Promise.all([
      db
        .select({
          id: schema.workspaces.id,
          name: schema.workspaces.name,
          slug: schema.workspaces.slug,
          ownerUserId: schema.workspaces.ownerUserId,
          planId: schema.workspaces.planId,
          planOverriddenUntil: schema.workspaces.planOverriddenUntil,
          createdAt: schema.workspaces.createdAt,
          deletedAt: schema.workspaces.deletedAt,
        })
        .from(schema.workspaces)
        .where(includeDeleted ? undefined : isNull(schema.workspaces.deletedAt))
        .orderBy(desc(schema.workspaces.createdAt)),
      db.select({ id: schema.plans.id, code: schema.plans.code }).from(schema.plans),
      db
        .select({
          workspaceId: schema.workspaceMembers.workspaceId,
          n: sql<number>`count(*)::int`,
        })
        .from(schema.workspaceMembers)
        .where(sql`${schema.workspaceMembers.acceptedAt} is not null`)
        .groupBy(schema.workspaceMembers.workspaceId),
      db
        .select({
          workspaceId: schema.workspaceMembers.workspaceId,
          n: sql<number>`count(*)::int`,
        })
        .from(schema.workspaceMembers)
        .where(isNull(schema.workspaceMembers.acceptedAt))
        .groupBy(schema.workspaceMembers.workspaceId),
      db
        .select({
          workspaceId: schema.subscriptions.workspaceId,
          status: schema.subscriptions.status,
          createdAt: schema.subscriptions.createdAt,
        })
        .from(schema.subscriptions)
        .orderBy(desc(schema.subscriptions.createdAt)),
      listAllAuthUsers(),
    ]);

  const planById = new Map(planRows.map((p) => [p.id, p.code as string]));
  const memberById = new Map(memberCountRows.map((r) => [r.workspaceId, r.n]));
  const pendingById = new Map(pendingCountRows.map((r) => [r.workspaceId, r.n]));
  const ownerByUser = new Map(users.map((u) => [u.id, u.email]));
  const latestSubByWs = new Map<string, SubscriptionStatus>();
  for (const s of latestSubs) {
    if (!latestSubByWs.has(s.workspaceId)) {
      latestSubByWs.set(s.workspaceId, s.status);
    }
  }

  return rows.map((w) => ({
    id: w.id,
    name: w.name,
    slug: w.slug,
    ownerUserId: w.ownerUserId,
    ownerEmail: ownerByUser.get(w.ownerUserId) ?? null,
    planCode: planById.get(w.planId) ?? "—",
    planOverriddenUntil: w.planOverriddenUntil,
    createdAt: w.createdAt,
    deletedAt: w.deletedAt,
    memberCount: memberById.get(w.id) ?? 0,
    pendingInviteCount: pendingById.get(w.id) ?? 0,
    subscriptionStatus: latestSubByWs.get(w.id) ?? null,
  }));
}

export type SuperWorkspaceDetail = {
  workspace: {
    id: string;
    name: string;
    slug: string;
    ownerUserId: string;
    ownerEmail: string | null;
    planCode: string;
    planOverriddenUntil: Date | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  };
  members: Array<{
    membershipId: string;
    userId: string | null;
    email: string | null;
    role: WorkspaceRole;
    invitedEmail: string | null;
    invitedAt: Date | null;
    acceptedAt: Date | null;
    createdAt: Date;
  }>;
  subscription: {
    id: string;
    status: SubscriptionStatus;
    provider: string;
    planCode: string;
    billingPeriod: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    trialEnd: Date | null;
    canceledAt: Date | null;
  } | null;
  recentBillingEvents: Array<{
    id: string;
    eventType: string;
    provider: string;
    receivedAt: Date;
    processedAt: Date | null;
    processingError: string | null;
  }>;
  usage: Array<{
    metric: string;
    value: number;
    periodStart: string;
    periodEnd: string;
  }>;
};

export async function getSuperWorkspaceDetail(
  workspaceId: string,
): Promise<SuperWorkspaceDetail | null> {
  const db = getDb();

  const wsRows = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  const w = wsRows[0];
  if (!w) return null;

  const [memberRows, subRows, billingRows, usageRows, planRows, owner] =
    await Promise.all([
      db
        .select()
        .from(schema.workspaceMembers)
        .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
        .orderBy(desc(schema.workspaceMembers.createdAt)),
      db
        .select()
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.workspaceId, workspaceId))
        .orderBy(desc(schema.subscriptions.createdAt))
        .limit(1),
      db
        .select({
          id: schema.billingEvents.id,
          eventType: schema.billingEvents.eventType,
          provider: schema.billingEvents.provider,
          receivedAt: schema.billingEvents.receivedAt,
          processedAt: schema.billingEvents.processedAt,
          processingError: schema.billingEvents.processingError,
        })
        .from(schema.billingEvents)
        .where(eq(schema.billingEvents.workspaceId, workspaceId))
        .orderBy(desc(schema.billingEvents.receivedAt))
        .limit(15),
      db
        .select({
          metric: schema.usageCounters.metric,
          value: schema.usageCounters.value,
          periodStart: schema.usageCounters.periodStart,
          periodEnd: schema.usageCounters.periodEnd,
        })
        .from(schema.usageCounters)
        .where(eq(schema.usageCounters.workspaceId, workspaceId))
        .orderBy(desc(schema.usageCounters.periodStart)),
      db.select({ id: schema.plans.id, code: schema.plans.code }).from(schema.plans),
      getAuthUser(w.ownerUserId),
    ]);

  const planById = new Map(planRows.map((p) => [p.id, p.code as string]));
  const memberUserIds = memberRows
    .map((m) => m.userId)
    .filter((x): x is string => x !== null);
  const memberUsers =
    memberUserIds.length === 0
      ? []
      : await Promise.all(memberUserIds.map((id) => getAuthUser(id)));
  const emailByUser = new Map(
    memberUsers.filter((u): u is AuthUser => u !== null).map((u) => [u.id, u.email]),
  );

  const sub = subRows[0] ?? null;

  return {
    workspace: {
      id: w.id,
      name: w.name,
      slug: w.slug,
      ownerUserId: w.ownerUserId,
      ownerEmail: owner?.email ?? null,
      planCode: planById.get(w.planId) ?? "—",
      planOverriddenUntil: w.planOverriddenUntil,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      deletedAt: w.deletedAt,
    },
    members: memberRows.map((m) => ({
      membershipId: m.id,
      userId: m.userId,
      email: m.userId ? emailByUser.get(m.userId) ?? null : m.invitedEmail,
      role: m.role,
      invitedEmail: m.invitedEmail,
      invitedAt: m.invitedAt,
      acceptedAt: m.acceptedAt,
      createdAt: m.createdAt,
    })),
    subscription: sub
      ? {
          id: sub.id,
          status: sub.status,
          provider: sub.provider,
          planCode: planById.get(sub.planId) ?? "—",
          billingPeriod: sub.billingPeriod,
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          trialEnd: sub.trialEnd,
          canceledAt: sub.canceledAt,
        }
      : null,
    recentBillingEvents: billingRows,
    usage: usageRows.map((u) => ({
      metric: u.metric,
      value: u.value,
      periodStart: u.periodStart,
      periodEnd: u.periodEnd,
    })),
  };
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export type SuperSubscriptionRow = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  ownerEmail: string | null;
  planCode: string;
  status: SubscriptionStatus;
  provider: string;
  billingPeriod: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  trialEnd: Date | null;
  createdAt: Date;
};

export async function listSuperSubscriptions(filter?: {
  status?: SubscriptionStatus;
}): Promise<SuperSubscriptionRow[]> {
  const db = getDb();
  const conditions = [] as ReturnType<typeof eq>[];
  if (filter?.status) {
    conditions.push(eq(schema.subscriptions.status, filter.status));
  }

  const [rows, planRows, users] = await Promise.all([
    db
      .select({
        id: schema.subscriptions.id,
        workspaceId: schema.subscriptions.workspaceId,
        planId: schema.subscriptions.planId,
        status: schema.subscriptions.status,
        provider: schema.subscriptions.provider,
        billingPeriod: schema.subscriptions.billingPeriod,
        currentPeriodStart: schema.subscriptions.currentPeriodStart,
        currentPeriodEnd: schema.subscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: schema.subscriptions.cancelAtPeriodEnd,
        trialEnd: schema.subscriptions.trialEnd,
        createdAt: schema.subscriptions.createdAt,
        workspaceName: schema.workspaces.name,
        workspaceSlug: schema.workspaces.slug,
        ownerUserId: schema.workspaces.ownerUserId,
      })
      .from(schema.subscriptions)
      .innerJoin(
        schema.workspaces,
        eq(schema.subscriptions.workspaceId, schema.workspaces.id),
      )
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.subscriptions.createdAt)),
    db.select({ id: schema.plans.id, code: schema.plans.code }).from(schema.plans),
    listAllAuthUsers(),
  ]);

  const planById = new Map(planRows.map((p) => [p.id, p.code as string]));
  const emailByUser = new Map(users.map((u) => [u.id, u.email]));

  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    workspaceName: r.workspaceName,
    workspaceSlug: r.workspaceSlug,
    ownerEmail: emailByUser.get(r.ownerUserId) ?? null,
    planCode: planById.get(r.planId) ?? "—",
    status: r.status,
    provider: r.provider,
    billingPeriod: r.billingPeriod,
    currentPeriodStart: r.currentPeriodStart,
    currentPeriodEnd: r.currentPeriodEnd,
    cancelAtPeriodEnd: r.cancelAtPeriodEnd,
    trialEnd: r.trialEnd,
    createdAt: r.createdAt,
  }));
}
