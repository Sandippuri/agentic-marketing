import type { ContentStatus, AssetStatus } from "@marketing/shared-types";

// content_items state machine. Plan §5 Phase 1 Day 3.
// Source of truth: this table. Both the API layer and tests check it.
const CONTENT_TRANSITIONS: Record<ContentStatus, readonly ContentStatus[]> = {
  draft: ["in_review"],
  in_review: ["draft", "approved"], // 'changes_requested' returns to draft
  approved: ["scheduled", "draft", "retracted"], // pulled back if needed
  scheduled: ["published", "approved", "retracted"], // un-schedule -> approved
  published: ["retracted"],
  retracted: [],
};

const ASSET_TRANSITIONS: Record<AssetStatus, readonly AssetStatus[]> = {
  draft: ["in_review"],
  in_review: ["draft", "approved"],
  approved: ["published", "draft"],
  published: [],
};

export function canTransitionContent(
  from: ContentStatus,
  to: ContentStatus,
): boolean {
  if (from === to) return false;
  return CONTENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionAsset(
  from: AssetStatus,
  to: AssetStatus,
): boolean {
  if (from === to) return false;
  return ASSET_TRANSITIONS[from]?.includes(to) ?? false;
}

export class InvalidTransitionError extends Error {
  constructor(
    public entity: "content" | "asset",
    public from: string,
    public to: string,
  ) {
    super(`Invalid ${entity} transition: ${from} -> ${to}`);
  }
}

export function assertContentTransition(
  from: ContentStatus,
  to: ContentStatus,
): void {
  if (!canTransitionContent(from, to)) {
    throw new InvalidTransitionError("content", from, to);
  }
}

export function assertAssetTransition(
  from: AssetStatus,
  to: AssetStatus,
): void {
  if (!canTransitionAsset(from, to)) {
    throw new InvalidTransitionError("asset", from, to);
  }
}
