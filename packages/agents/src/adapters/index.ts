import type { Channel, PublishingAdapter } from "@marketing/shared-types";
import type { CpClient } from "@marketing/cp-client";
import { InternalBlogAdapter } from "./internal-blog";
import { LinkedInAdapter } from "./linkedin";
import { XAdapter } from "./x";
import { InstagramAdapter } from "./instagram";
import { FacebookAdapter } from "./facebook";
import { HubspotEmailAdapter } from "./hubspot-email";
import { MailchimpAdapter } from "./mailchimp";

export {
  InternalBlogAdapter,
  LinkedInAdapter,
  XAdapter,
  InstagramAdapter,
  FacebookAdapter,
  HubspotEmailAdapter,
  MailchimpAdapter,
};

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

  if (process.env.META_PAGE_ACCESS_TOKEN && process.env.IG_BUSINESS_ACCOUNT_ID) {
    adapters.instagram = new InstagramAdapter();
  }

  if (process.env.META_PAGE_ACCESS_TOKEN && process.env.FB_PAGE_ID) {
    adapters.facebook = new FacebookAdapter();
  }

  if (process.env.HUBSPOT_ACCESS_TOKEN) {
    adapters.email_hubspot = new HubspotEmailAdapter();
  }

  if (process.env.MAILCHIMP_API_KEY) {
    adapters.email_mailchimp = new MailchimpAdapter();
  }

  return adapters;
}
