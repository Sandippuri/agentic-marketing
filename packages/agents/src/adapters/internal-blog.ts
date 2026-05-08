import type { Channel, PublishingAdapter } from "@marketing/shared-types";
import type { CpClient } from "@marketing/cp-client";

// The internal blog isn't an external system — "publishing" means flipping the
// content_item to status='published' with a stable URL under /blog/<slug>.
// The Distributor's runJob already PATCHes the publish_jobs status to
// 'succeeded' which fans out to content_items.published_url; this adapter just
// computes the URL.
//
// Slug = slugified title + 6-char suffix from the content_id, so renames don't
// collide and pre-existing /blog/<slug> URLs stay stable.
export class InternalBlogAdapter
  implements PublishingAdapter<{ contentId: string }>
{
  readonly channel: Channel = "internal_blog";

  constructor(private readonly cp: CpClient) {}

  async publish(payload: { contentId: string }) {
    const content = await this.cp.getContent(payload.contentId);
    const slug = `${slugify(content.title)}-${payload.contentId.slice(0, 6)}`;
    const url = `/blog/${slug}`;
    return { externalId: payload.contentId, externalUrl: url };
  }

  async retract(externalId: string) {
    // Retracting an internal-blog post means flipping content -> retracted.
    // The Control Plane's PATCH route handles the transition; we just need the
    // contentId, which is the externalId we returned at publish time.
    await this.cp.patchContent(externalId, {});
    // TODO: add an explicit /api/content/:id/retract endpoint when we wire
    // public retraction into the admin UI.
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "post";
}
