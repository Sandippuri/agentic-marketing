/**
 * Channel → AssetTemplate registry. The pipeline picks a template via the
 * resolved channel from the loaded context. Adding a new template = adding
 * one file and one entry here.
 */
import type { AssetTemplate } from "./types";
import { linkedinPoster } from "./linkedin-poster";
import { xPoster } from "./x-poster";
import { blogOg } from "./blog-og";
import { emailHeader } from "./email-header";

export * from "./types";
export { linkedinPoster, xPoster, blogOg, emailHeader };

export const TEMPLATES: AssetTemplate[] = [
  linkedinPoster,
  xPoster,
  blogOg,
  emailHeader,
];

const BY_CHANNEL: Record<string, AssetTemplate> = {
  linkedin: linkedinPoster,
  x: xPoster,
  x_post: xPoster,
  x_thread: xPoster,
  internal_blog: blogOg,
  blog: blogOg,
  email_hubspot: emailHeader,
  email_mailchimp: emailHeader,
  email: emailHeader,
};

/**
 * Pick a template for the given channel. Falls back to the LinkedIn poster
 * for unknown channels — a sensible default that's still visually correct
 * (it's square, which crops gracefully into other shapes).
 */
export function pickTemplate(channel: string): AssetTemplate {
  return BY_CHANNEL[channel] ?? linkedinPoster;
}
