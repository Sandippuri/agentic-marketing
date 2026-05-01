import type {
  Channel,
  ContentStatus,
  ContentStage,
  ContentType,
  CampaignPhase,
  CampaignStatus,
  ApprovalDecision,
  PublishJobStatus,
  ScopeType,
  ThreadRef,
  SettingsShape,
} from "@marketing/shared-types";

export type CpClientOptions = {
  baseUrl: string;
  internalToken: string;
  fetchImpl?: typeof fetch;
};

export type CampaignDto = {
  id: string;
  slug: string;
  name: string;
  status: CampaignStatus;
  phase: CampaignPhase;
  startDate: string | null;
  endDate: string | null;
  briefMd: string | null;
  calendarJson: unknown | null;
  createdAt: string;
  updatedAt: string;
};

export type ContentItemDto = {
  id: string;
  campaignId: string;
  type: ContentType;
  stage: ContentStage;
  title: string;
  bodyMd: string;
  status: ContentStatus;
  scheduledFor: string | null;
  publishedAt: string | null;
  publishedUrl: string | null;
};

export type PublishJobDto = {
  id: string;
  contentId: string;
  channel: Channel;
  status: PublishJobStatus;
  externalId: string | null;
  externalUrl: string | null;
  error: string | null;
  threadRef: ThreadRef | null;
};

export type ApprovalDto = {
  id: string;
  contentId: string;
  decision: ApprovalDecision | null;
  decidedAt: string | null;
  reason: string | null;
};

// Thin error class so callers can branch on rejected publish-gate (409).
export class CpHttpError extends Error {
  constructor(
    public status: number,
    public method: string,
    public path: string,
    public body: unknown,
  ) {
    super(`CP ${method} ${path} -> ${status}`);
  }
}

export class CpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: CpClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-internal-token": this.opts.internalToken,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) throw new CpHttpError(res.status, method, path, parsed);
    return parsed as T;
  }

  // --- campaigns ----------------------------------------------------------
  listCampaigns(params?: { status?: CampaignStatus; phase?: CampaignPhase }) {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.phase) qs.set("phase", params.phase);
    const query = qs.toString() ? `?${qs.toString()}` : "";
    return this.req<CampaignDto[]>("GET", `/api/campaigns${query}`);
  }
  getCampaign(id: string) {
    return this.req<CampaignDto>("GET", `/api/campaigns/${id}`);
  }
  createCampaign(input: {
    slug: string;
    name: string;
    phase?: CampaignPhase;
    briefMd?: string;
  }) {
    return this.req<CampaignDto>("POST", "/api/campaigns", input);
  }
  patchCampaign(id: string, input: Partial<{ name: string; phase: CampaignPhase; briefMd: string; calendarJson: unknown }>) {
    return this.req<CampaignDto>("PATCH", `/api/campaigns/${id}`, input);
  }

  // --- content ------------------------------------------------------------
  listContent(params?: {
    campaignId?: string;
    status?: ContentStatus;
    type?: ContentType;
    limit?: number;
    offset?: number;
  }) {
    const qs = new URLSearchParams();
    if (params?.campaignId) qs.set("campaignId", params.campaignId);
    if (params?.status) qs.set("status", params.status);
    if (params?.type) qs.set("type", params.type);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    const query = qs.toString() ? `?${qs.toString()}` : "";
    return this.req<{ items: ContentItemDto[]; total: number; limit: number; offset: number }>(
      "GET",
      `/api/content${query}`,
    );
  }
  getContent(id: string) {
    return this.req<ContentItemDto>("GET", `/api/content/${id}`);
  }
  createContent(input: {
    campaignId: string;
    type: ContentType;
    stage?: ContentStage;
    title: string;
    bodyMd: string;
  }) {
    return this.req<ContentItemDto>("POST", "/api/content", input);
  }
  patchContent(id: string, input: Partial<{ title: string; bodyMd: string }>) {
    return this.req<ContentItemDto>("PATCH", `/api/content/${id}`, input);
  }
  submitContent(id: string) {
    return this.req<ContentItemDto>("POST", `/api/content/${id}/submit`, {});
  }

  // --- approvals ----------------------------------------------------------
  decideApproval(
    id: string,
    input: { decision: ApprovalDecision; reason?: string; decidedBy?: string },
  ) {
    return this.req<ApprovalDto>("POST", `/api/approvals/${id}`, input);
  }
  getApprovalsForContent(contentId: string) {
    return this.req<ApprovalDto[]>("GET", `/api/approvals?contentId=${contentId}`);
  }
  getPendingApprovals(limit = 20) {
    return this.req<{
      items: Array<{
        id: string;
        contentId: string;
        contentTitle: string;
        contentType: string;
        contentStage: string;
        requestedAt: string;
        ageMinutes: number;
      }>;
      total: number;
    }>("GET", `/api/approvals?pending=true&limit=${limit}`);
  }

  // --- publish-jobs -------------------------------------------------------
  listPublishJobs(params?: {
    contentId?: string;
    status?: PublishJobStatus;
    channel?: Channel;
    limit?: number;
    offset?: number;
  }) {
    const qs = new URLSearchParams();
    if (params?.contentId) qs.set("contentId", params.contentId);
    if (params?.status) qs.set("status", params.status);
    if (params?.channel) qs.set("channel", params.channel);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    const query = qs.toString() ? `?${qs.toString()}` : "";
    return this.req<{ items: PublishJobDto[]; total: number; limit: number; offset: number }>(
      "GET",
      `/api/publish-jobs${query}`,
    );
  }
  getPublishJob(id: string) {
    return this.req<PublishJobDto>("GET", `/api/publish-jobs/${id}`);
  }
  enqueuePublish(input: {
    contentId: string;
    channel: Channel;
    scheduledAt?: string;
    threadRef?: ThreadRef;
  }) {
    return this.req<PublishJobDto>("POST", "/api/publish-jobs", input);
  }
  patchPublishJob(
    id: string,
    input: Partial<{
      status: PublishJobStatus;
      externalId: string;
      externalUrl: string;
      error: string;
    }>,
  ) {
    return this.req<PublishJobDto>("PATCH", `/api/publish-jobs/${id}`, input);
  }

  // --- assets -------------------------------------------------------------
  createAsset(input: {
    contentId?: string;
    kind: string;
    storagePath: string;
    templateId?: string;
    promptUsed?: string;
  }) {
    return this.req<{
      id: string;
      contentId: string | null;
      kind: string;
      storagePath: string;
      status: string;
      signedUrl?: string | null;
    }>("POST", "/api/assets", input);
  }
  getAsset(id: string) {
    return this.req<{ id: string; storagePath: string; signedUrl: string | null }>(
      "GET",
      `/api/assets/${id}`,
    );
  }

  // --- metrics ------------------------------------------------------------
  recordMetrics(input: {
    scopeType: ScopeType;
    scopeId: string;
    metrics: Array<{
      metric: string;
      value: number;
      channel?: Channel;
      observedAt?: string;
    }>;
  }) {
    return this.req<{ inserted: number }>("POST", "/api/metrics", input);
  }

  getMetrics(params: { scopeType: ScopeType; scopeId: string; channel?: Channel }) {
    const qs = new URLSearchParams({
      scopeType: params.scopeType,
      scopeId: params.scopeId,
      ...(params.channel ? { channel: params.channel } : {}),
    });
    return this.req<Array<{ metric: string; value: string; channel: Channel | null; observedAt: string }>>(
      "GET",
      `/api/metrics?${qs.toString()}`,
    );
  }

  // --- thread-notify ------------------------------------------------------
  notifyThread(input: { threadRef: ThreadRef; message: string }) {
    return this.req<{ ok: true }>("POST", "/api/thread-notify", input);
  }

  // --- settings -----------------------------------------------------------
  getSettings() {
    return this.req<Partial<SettingsShape>>("GET", "/api/settings");
  }

  // --- publish-job stats --------------------------------------------------
  getTodayChannelCounts() {
    return this.req<Partial<Record<Channel, number>>>(
      "GET",
      "/api/publish-jobs/today-count",
    );
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
