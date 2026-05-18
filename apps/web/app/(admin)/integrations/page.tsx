import { redirect } from "next/navigation";
import { getSupabaseServer } from "@/lib/supabase/server";
import { lookupAdminRole } from "@/lib/billing/admin";
import { PageHeader, Badge } from "../ui";

export const dynamic = "force-dynamic";

type Status = "connected" | "partial" | "missing";

type Integration = {
  id: string;
  name: string;
  category: "Chat" | "Channel" | "AI" | "Analytics" | "Assets" | "Ops";
  description: string;
  envVars: string[];
  /** Per-var aliases — any one of the listed names being set counts as that var being set. */
  envAliases?: Record<string, string[]>;
  /** Provider admin/console URL — opens in a new tab on Connect. */
  setupUrl: string;
  /** Short steps to follow on the provider side. */
  setupSteps?: string[];
};

const INTEGRATIONS: Integration[] = [
  {
    id: "slack",
    name: "Slack",
    category: "Chat",
    description: "Receive @marketing mentions and post weekly reports.",
    envVars: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET"],
    setupUrl: "https://api.slack.com/apps",
    setupSteps: [
      "Create a new Slack app (or open an existing one).",
      "Add scopes: app_mentions:read, chat:write, commands, users:read, views:open.",
      "Enable Socket Mode and create an App-Level Token with connections:write.",
      "Copy the Bot Token, App Token, and Signing Secret into your env.",
    ],
  },
  {
    id: "discord",
    name: "Discord",
    category: "Chat",
    description: "Alternative chat surface for @marketing mentions.",
    envVars: ["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_GUILD_ID"],
    setupUrl: "https://discord.com/developers/applications",
    setupSteps: [
      "Create a new Application, then add a Bot.",
      "Enable bot + applications.commands OAuth scopes.",
      "Copy the Bot Token, Client ID, and target Guild ID into your env.",
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    category: "AI",
    description: "Powers every sub-agent (Strategist, Content, Analyst, Asset).",
    envVars: ["ANTHROPIC_API_KEY"],
    setupUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    name: "OpenAI",
    category: "AI",
    description: "Embeddings for findSimilarContent / brand RAG, gpt-image-1 images, and Sora 2 / Sora 2 Pro video.",
    envVars: ["OPENAI_API_KEY"],
    setupUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    category: "AI",
    description: "Optional model provider for the test-chat sandbox.",
    envVars: ["GEMINI_API_KEY"],
    envAliases: {
      GEMINI_API_KEY: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    },
    setupUrl: "https://aistudio.google.com/app/apikey",
    setupSteps: [
      "Open Google AI Studio → Get API key → Create API key.",
      "Paste it as GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) into env.",
    ],
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    category: "Channel",
    description: "Publish company posts via the Marketing API.",
    envVars: ["LINKEDIN_ACCESS_TOKEN", "LINKEDIN_ORGANIZATION_URN"],
    setupUrl: "https://www.linkedin.com/developers/apps",
    setupSteps: [
      "Create a LinkedIn developer app and request Marketing API access (1–4 weeks).",
      "Generate a long-lived access token scoped to your organization.",
      "Find your org URN (urn:li:organization:NNNN) and paste both into env.",
    ],
  },
  {
    id: "x",
    name: "X (Twitter)",
    category: "Channel",
    description: "Publish tweets and threads.",
    envVars: [
      "X_API_KEY",
      "X_API_KEY_SECRET",
      "X_ACCESS_TOKEN",
      "X_ACCESS_TOKEN_SECRET",
    ],
    setupUrl: "https://developer.x.com/en/portal/dashboard",
    setupSteps: [
      "Open Projects → Keys & Tokens for your app (Basic tier or higher).",
      "Generate API Key + Secret and an Access Token + Secret with write access.",
      "Paste all four into env.",
    ],
  },
  {
    id: "facebook",
    name: "Facebook",
    category: "Channel",
    description: "Publish posts to a Facebook Page feed via the Meta Graph API.",
    envVars: ["META_PAGE_ACCESS_TOKEN", "FB_PAGE_ID"],
    setupUrl: "https://developers.facebook.com/apps/",
    setupSteps: [
      "Create a Meta for Developers app (Business type) and add the Facebook Login + Pages products.",
      "Generate a long-lived Page Access Token with pages_manage_posts + pages_read_engagement scopes.",
      "Copy the token into META_PAGE_ACCESS_TOKEN and the Page numeric ID into FB_PAGE_ID.",
    ],
  },
  {
    id: "instagram",
    name: "Instagram",
    category: "Channel",
    description: "Publish photos and Reels to an Instagram Business account.",
    envVars: ["META_PAGE_ACCESS_TOKEN", "IG_BUSINESS_ACCOUNT_ID"],
    setupUrl: "https://developers.facebook.com/apps/",
    setupSteps: [
      "Convert the target Instagram account to Business or Creator and link it to the Facebook Page used above.",
      "Reuse META_PAGE_ACCESS_TOKEN — the linked Page token works for IG Graph calls.",
      "Find the IG user ID via /me/accounts → instagram_business_account and paste it into IG_BUSINESS_ACCOUNT_ID.",
    ],
  },
  {
    id: "hubspot",
    name: "HubSpot Email",
    category: "Channel",
    description: "Send marketing email via HubSpot Private App.",
    envVars: [
      "HUBSPOT_ACCESS_TOKEN",
      "HUBSPOT_PORTAL_ID",
      "HUBSPOT_DEFAULT_LIST_ID",
    ],
    setupUrl: "https://app.hubspot.com/private-apps",
    setupSteps: [
      "Settings → Integrations → Private Apps → Create app.",
      "Grant marketing.email + marketing.lists scopes.",
      "Copy the access token, portal ID, and default list ID into env.",
    ],
  },
  {
    id: "mailchimp",
    name: "Mailchimp",
    category: "Channel",
    description: "Send marketing email via Mailchimp campaigns.",
    envVars: [
      "MAILCHIMP_API_KEY",
      "MAILCHIMP_SERVER_PREFIX",
      "MAILCHIMP_DEFAULT_LIST_ID",
      "MAILCHIMP_FROM_EMAIL",
      "MAILCHIMP_FROM_NAME",
    ],
    setupUrl: "https://admin.mailchimp.com/account/api/",
    setupSteps: [
      "Account → Extras → API keys → Create A Key.",
      "Server prefix is the suffix after the dash in the API key (e.g. 'us1').",
      "Paste the key, prefix, list ID, and From identity into env.",
    ],
  },
  {
    id: "replicate",
    name: "Replicate",
    category: "Assets",
    description: "AI image generation (FLUX / SDXL / Ideogram) and Wan 2.6 video (t2v + i2v).",
    envVars: ["REPLICATE_API_TOKEN"],
    setupUrl: "https://replicate.com/account/api-tokens",
  },
  {
    id: "ga4",
    name: "Google Analytics 4",
    category: "Analytics",
    description: "Pulls page-level metrics for the Analyst weekly report.",
    envVars: ["GA4_PROPERTY_ID", "GA4_SERVICE_ACCOUNT_JSON"],
    setupUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts",
    setupSteps: [
      "Create a service account, generate a JSON key, download it.",
      "Grant the service account 'Viewer' on your GA4 property (Admin → Property access).",
      "Set GA4_PROPERTY_ID and paste the JSON key (single line) into GA4_SERVICE_ACCOUNT_JSON.",
    ],
  },
  {
    id: "otel",
    name: "OpenTelemetry",
    category: "Ops",
    description: "Optional traces/logs export to Grafana Cloud (or any OTLP).",
    envVars: [
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "OTEL_SERVICE_NAME",
    ],
    setupUrl: "https://grafana.com/auth/sign-in",
  },
];

function isVarSet(name: string, aliases?: Record<string, string[]>): boolean {
  const candidates = aliases?.[name] ?? [name];
  return candidates.some((c) => !!process.env[c]);
}

function statusOf(
  envVars: string[],
  aliases?: Record<string, string[]>,
): Status {
  const set = envVars.filter((v) => isVarSet(v, aliases));
  if (set.length === 0) return "missing";
  if (set.length === envVars.length) return "connected";
  return "partial";
}

const STATUS_TONE: Record<Status, "success" | "warn" | "neutral"> = {
  connected: "success",
  partial: "warn",
  missing: "neutral",
};

const STATUS_LABEL: Record<Status, string> = {
  connected: "Connected",
  partial: "Needs attention",
  missing: "Not connected",
};

// Channel cards a platform user sees — every other category (AI / Chat /
// Assets / Analytics / Ops) is platform infrastructure and stays behind the
// superadmin view.
const USER_VISIBLE_IDS = new Set([
  "linkedin",
  "x",
  "facebook",
  "instagram",
  "hubspot",
  "mailchimp",
]);

// Friendlier copy for the user view. The operator description leaks
// implementation details ("Marketing API", "Private App"); users care
// whether the channel will publish for them.
const USER_DESCRIPTIONS: Record<string, string> = {
  linkedin: "Publish company posts to LinkedIn.",
  x: "Publish tweets and threads to X.",
  facebook: "Publish posts to your Facebook Page.",
  instagram: "Publish photos and Reels to Instagram.",
  hubspot: "Send marketing email through HubSpot.",
  mailchimp: "Send marketing email through Mailchimp.",
};

export default async function IntegrationsPage() {
  const sb = await getSupabaseServer();
  const { data: userData } = await sb.auth.getUser();
  if (!userData.user) redirect("/login?next=/integrations");
  const isSuperadmin =
    (await lookupAdminRole(userData.user.id)) === "superadmin";

  const items = INTEGRATIONS.map((i) => ({
    ...i,
    status: statusOf(i.envVars, i.envAliases),
    presentVars: i.envVars.filter((v) => isVarSet(v, i.envAliases)),
  }));

  if (!isSuperadmin) {
    return <UserIntegrationsView items={items} />;
  }
  return <OperatorIntegrationsView items={items} />;
}

// ---------- Platform-user view ----------------------------------------------

function UserIntegrationsView({
  items,
}: {
  items: (Integration & { status: Status; presentVars: string[] })[];
}) {
  const channels = items.filter((i) => USER_VISIBLE_IDS.has(i.id));

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Integrations"
        description="Connect the channels you want to publish to. Connections are managed by the workspace owner."
      />

      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {channels.map((i) => (
          <UserChannelCard
            key={i.id}
            name={i.name}
            description={USER_DESCRIPTIONS[i.id] ?? i.description}
            status={i.status}
          />
        ))}
      </ul>

      <p className="mt-6 text-xs text-faint">
        Per-workspace OAuth is coming soon. In the meantime, ask your workspace
        owner to wire these up.
      </p>
    </div>
  );
}

function UserChannelCard({
  name,
  description,
  status,
}: {
  name: string;
  description: string;
  status: Status;
}) {
  // We render every channel as "Not connected" for the user view because the
  // env-var status is platform-global; it doesn't reflect whether THIS
  // workspace has connected the channel. Per-workspace OAuth lands later.
  const userFacingStatus: Status = "missing";
  return (
    <li className="surface p-4 flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-ink">{name}</div>
          <p className="text-xs text-mid mt-0.5 leading-snug">{description}</p>
        </div>
        <Badge tone={STATUS_TONE[userFacingStatus]} dot>
          {STATUS_LABEL[userFacingStatus]}
        </Badge>
      </div>
      <div className="mt-4">
        <button
          type="button"
          disabled
          className="btn btn-secondary btn-sm opacity-60 cursor-not-allowed"
          title="Per-workspace connect is coming soon"
        >
          Connect
        </button>
      </div>
    </li>
  );
}

// ---------- Operator view (existing env-var dashboard) ----------------------

function OperatorIntegrationsView({
  items,
}: {
  items: (Integration & { status: Status; presentVars: string[] })[];
}) {
  const counts = {
    connected: items.filter((i) => i.status === "connected").length,
    partial: items.filter((i) => i.status === "partial").length,
    missing: items.filter((i) => i.status === "missing").length,
  };

  const byCategory = new Map<Integration["category"], typeof items>();
  for (const i of items) {
    if (!byCategory.has(i.category)) byCategory.set(i.category, []);
    byCategory.get(i.category)!.push(i);
  }

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Integrations"
        description="Operator view. Status is computed from environment variables. Use Connect to open the provider, generate credentials, paste them into env, then restart the affected service."
        meta={
          <>
            <Badge tone="success" dot>
              {counts.connected} connected
            </Badge>
            {counts.partial > 0 && (
              <Badge tone="warn" dot>
                {counts.partial} needs attention
              </Badge>
            )}
            <Badge tone="neutral">{counts.missing} not connected</Badge>
          </>
        }
      />

      <div className="space-y-8">
        {[...byCategory.entries()].map(([category, list]) => (
          <section key={category}>
            <h2 className="section-title mb-3">{category}</h2>
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {list.map((i) => (
                <IntegrationCard key={i.id} integration={i} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function IntegrationCard({
  integration,
}: {
  integration: Integration & { status: Status; presentVars: string[] };
}) {
  const { name, description, envVars, presentVars, setupUrl, setupSteps, status } =
    integration;
  const isConnected = status === "connected";
  const buttonLabel = isConnected
    ? "Manage"
    : status === "partial"
      ? "Finish setup"
      : "Connect";

  return (
    <li className="surface p-4 flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-ink">{name}</div>
          <p className="text-xs text-mid mt-0.5 leading-snug">{description}</p>
        </div>
        <Badge tone={STATUS_TONE[status]} dot>
          {STATUS_LABEL[status]}
        </Badge>
      </div>

      <ul className="mt-3 space-y-1 text-xs mono">
        {envVars.map((v) => {
          const set = presentVars.includes(v);
          return (
            <li
              key={v}
              className="flex items-center justify-between gap-2 text-mid"
            >
              <span className="truncate text-faint">{v}</span>
              <span
                className={[
                  "inline-flex items-center gap-1 shrink-0",
                  set ? "text-[var(--success)]" : "text-faint",
                ].join(" ")}
              >
                <span
                  className={`h-1 w-1 rounded-full ${
                    set ? "bg-[var(--success)]" : "bg-[var(--border-strong)]"
                  }`}
                />
                {set ? "set" : "not set"}
              </span>
            </li>
          );
        })}
      </ul>

      {setupSteps && (
        <details className="mt-3 text-xs text-mid">
          <summary className="cursor-pointer hover:text-ink transition-colors">
            Setup steps
          </summary>
          <ol className="list-decimal list-inside mt-2 space-y-1 text-low">
            {setupSteps.map((s, idx) => (
              <li key={idx}>{s}</li>
            ))}
          </ol>
        </details>
      )}

      <div className="mt-4 flex gap-2">
        <a
          href={setupUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={isConnected ? "btn btn-secondary btn-sm" : "btn btn-primary btn-sm"}
        >
          {buttonLabel}
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 17L17 7M7 7h10v10" />
          </svg>
        </a>
      </div>
    </li>
  );
}
