import type {
  Channel,
  ContentStatus,
  ContentStage,
  ContentType,
  CampaignPhase,
  CampaignStatus,
  ApprovalDecision,
  PublishJobStatus,
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
  listCampaigns() {
    return this.req<CampaignDto[]>("GET", "/api/campaigns");
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

  // --- publish-jobs -------------------------------------------------------
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
