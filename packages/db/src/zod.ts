import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import {
  campaigns,
  contentItems,
  contentRevisions,
  approvals,
  publishJobs,
  assets,
  metrics,
  auditLog,
  settings,
} from "./schema";

// Insert schemas — used to validate POST/PATCH payloads in Route Handlers.
export const insertCampaignSchema = createInsertSchema(campaigns);
export const insertContentItemSchema = createInsertSchema(contentItems);
export const insertContentRevisionSchema = createInsertSchema(contentRevisions);
export const insertApprovalSchema = createInsertSchema(approvals);
export const insertPublishJobSchema = createInsertSchema(publishJobs);
export const insertAssetSchema = createInsertSchema(assets);
export const insertMetricSchema = createInsertSchema(metrics);
export const insertAuditSchema = createInsertSchema(auditLog);
export const insertSettingSchema = createInsertSchema(settings);

// Select schemas — used to type API responses.
export const selectCampaignSchema = createSelectSchema(campaigns);
export const selectContentItemSchema = createSelectSchema(contentItems);
export const selectApprovalSchema = createSelectSchema(approvals);
export const selectPublishJobSchema = createSelectSchema(publishJobs);
export const selectAssetSchema = createSelectSchema(assets);
