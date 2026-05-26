import type { Channel } from "@marketing/shared-types";
import type {
  FacebookCreds,
  InstagramCreds,
  LinkedInCreds,
  SocialAdapterCreds,
} from "@marketing/agents/adapters";
import { getConnection } from "./repository";

// Bridge from a Channel (publish target) to the per-workspace credentials each
// adapter constructor needs. Returns null when the workspace has not connected
// the provider yet — callers can then surface a 412/skip instead of throwing.
//
// LinkedIn maps 1:1 to the linkedin provider. Facebook + Instagram both share
// the meta provider (one Page connection, two channels).

export async function loadSocialAdapterCreds(
  workspaceId: string,
  channel: Channel,
): Promise<SocialAdapterCreds | null> {
  if (channel === "linkedin") {
    const c = await getConnection(workspaceId, "linkedin");
    if (!c) return null;
    const authorUrn =
      (c.metadata.authorUrn as string | undefined) ?? c.accountId;
    const creds: LinkedInCreds = {
      accessToken: c.accessToken,
      authorUrn,
    };
    return { channel: "linkedin", creds };
  }
  if (channel === "facebook") {
    const c = await getConnection(workspaceId, "meta");
    if (!c) return null;
    const pageId =
      (c.metadata.selectedPageId as string | undefined) ?? c.accountId;
    const creds: FacebookCreds = {
      pageAccessToken: c.accessToken,
      pageId,
    };
    return { channel: "facebook", creds };
  }
  if (channel === "instagram") {
    const c = await getConnection(workspaceId, "meta");
    if (!c) return null;
    const igId = c.metadata.instagramBusinessAccountId as string | undefined;
    if (!igId) return null; // Page has no linked IG Business account.
    const creds: InstagramCreds = {
      pageAccessToken: c.accessToken,
      igBusinessAccountId: igId,
    };
    return { channel: "instagram", creds };
  }
  return null;
}
