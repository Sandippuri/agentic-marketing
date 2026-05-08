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
  agentFeedback,
  outcomes,
  kbCollections,
  kbDocuments,
  kbChunks,
  goalEvents,
  experiments,
  lifecycleSequences,
  lifecycleSteps,
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
export const insertAgentFeedbackSchema = createInsertSchema(agentFeedback);
export const insertOutcomeSchema = createInsertSchema(outcomes);
export const insertKbCollectionSchema = createInsertSchema(kbCollections);
export const insertKbDocumentSchema = createInsertSchema(kbDocuments);
export const insertKbChunkSchema = createInsertSchema(kbChunks);
export const insertGoalEventSchema = createInsertSchema(goalEvents);
export const insertExperimentSchema = createInsertSchema(experiments);
export const insertLifecycleSequenceSchema = createInsertSchema(lifecycleSequences);
export const insertLifecycleStepSchema = createInsertSchema(lifecycleSteps);

// Select schemas — used to type API responses.
export const selectCampaignSchema = createSelectSchema(campaigns);
export const selectContentItemSchema = createSelectSchema(contentItems);
export const selectApprovalSchema = createSelectSchema(approvals);
export const selectPublishJobSchema = createSelectSchema(publishJobs);
export const selectAssetSchema = createSelectSchema(assets);
export const selectAgentFeedbackSchema = createSelectSchema(agentFeedback);
export const selectOutcomeSchema = createSelectSchema(outcomes);
export const selectKbCollectionSchema = createSelectSchema(kbCollections);
export const selectKbDocumentSchema = createSelectSchema(kbDocuments);
export const selectKbChunkSchema = createSelectSchema(kbChunks);
export const selectGoalEventSchema = createSelectSchema(goalEvents);
export const selectExperimentSchema = createSelectSchema(experiments);
export const selectLifecycleSequenceSchema = createSelectSchema(lifecycleSequences);
export const selectLifecycleStepSchema = createSelectSchema(lifecycleSteps);
