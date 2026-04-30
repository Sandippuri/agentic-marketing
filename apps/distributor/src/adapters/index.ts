import type { Channel, PublishingAdapter } from "@marketing/shared-types";
import type { CpClient } from "@marketing/cp-client";
import { InternalBlogAdapter } from "./internal-blog";
import { LinkedInAdapter } from "./linkedin";
import { XAdapter } from "./x";
import { HubspotEmailAdapter } from "./hubspot-email";
import { MailchimpAdapter } from "./mailchimp";

// Adapter registry.
// Phase 5:   internal_blog — live.
// Phase 6:   linkedin, x — stubs; enable once OAuth credentials are in Doppler.
// Phase 7:   email_hubspot / email_mailchimp — stubs; enable once OAuth is set.
export function buildAdapters(
  cp: CpClient,
): Partial<Record<Channel, PublishingAdapter>> {
  const adapters: Partial<Record<Channel, PublishingAdapter>> = {
    internal_blog: new InternalBlogAdapter(cp),
  };

  if (process.env.LINKEDIN_ACCESS_TOKEN && process.env.LINKEDIN_ORGANIZATION_URN) {
    adapters.linkedin = new LinkedInAdapter();
  }

  if (process.env.X_ACCESS_TOKEN) {
    adapters.x = new XAdapter();
  }

  if (process.env.HUBSPOT_ACCESS_TOKEN) {
    adapters.email_hubspot = new HubspotEmailAdapter();
  }

  if (process.env.MAILCHIMP_API_KEY) {
    adapters.email_mailchimp = new MailchimpAdapter();
  }

  return adapters;
}
