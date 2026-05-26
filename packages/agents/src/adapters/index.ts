import type { Channel, PublishingAdapter } from "@marketing/shared-types";
import type { CpClient } from "@marketing/cp-client";
import { InternalBlogAdapter } from "./internal-blog";
import {
  LinkedInAdapter,
  type LinkedInCreds,
} from "./linkedin";
import { XAdapter } from "./x";
import {
  InstagramAdapter,
  type InstagramCreds,
} from "./instagram";
import {
  FacebookAdapter,
  type FacebookCreds,
} from "./facebook";
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

export type { LinkedInCreds, InstagramCreds, FacebookCreds };

// Adapter registry for env-only channels (internal_blog, X, email). LinkedIn,
// Facebook, and Instagram require per-workspace OAuth credentials and are
// constructed via buildSocialAdapter() below — they no longer appear here.
export function buildAdapters(
  cp: CpClient,
): Partial<Record<Channel, PublishingAdapter>> {
  const adapters: Partial<Record<Channel, PublishingAdapter>> = {
    internal_blog: new InternalBlogAdapter(cp),
  };

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

export type SocialAdapterCreds =
  | { channel: "linkedin"; creds: LinkedInCreds }
  | { channel: "facebook"; creds: FacebookCreds }
  | { channel: "instagram"; creds: InstagramCreds };

/**
 * Build a workspace-scoped publishing adapter for a social channel using
 * credentials loaded from social_connections. Returns null if the channel
 * is not OAuth-backed (e.g. internal_blog, email, x).
 */
export function buildSocialAdapter(
  spec: SocialAdapterCreds,
): PublishingAdapter | null {
  switch (spec.channel) {
    case "linkedin":
      return new LinkedInAdapter(spec.creds);
    case "facebook":
      return new FacebookAdapter(spec.creds);
    case "instagram":
      return new InstagramAdapter(spec.creds);
  }
}
