// Public surface of the billing/entitlement layer. Importers should reach
// for these symbols and avoid deep-importing the sub-modules.

export {
  EntitlementError,
  QuotaExceededError,
  WorkspaceNotFoundError,
  NotWorkspaceMemberError,
  SuperadminRequiredError,
} from "./errors";

export {
  getPlanById,
  getPlanByCode,
  listPublicPlans,
  _resetPlanCache,
  type LoadedPlan,
} from "./plans";

export {
  ensurePersonalWorkspace,
  listMembershipsForUser,
  loadWorkspaceForUser,
  workspaceSlugExists,
  type WorkspaceMembership,
} from "./workspaces";

export {
  ACTIVE_WORKSPACE_COOKIE,
  getWorkspaceContext,
  getWorkspaceContextStrict,
  type WorkspaceContext,
} from "./workspace-context";

export {
  isSuperadmin,
  lookupAdminRole,
  requireSuperadmin,
  type AdminContext,
} from "./admin";

export {
  LEGACY_WORKSPACE_ID,
  workspaceWhere,
  whereInWorkspace,
  withWorkspaceField,
  type TenantTable,
} from "./scoped-db";
