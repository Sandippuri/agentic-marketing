"use client";

// Per-thread persisted approval cards. Cards arrive via the SSE bus
// (apps/web/lib/chat/web-bus.ts) and used to live only in component state —
// switching threads or refreshing the page lost them. Now stored in
// localStorage keyed by threadRef so they survive both.
//
// Decision state is stored alongside the card. After a decision succeeds,
// `setDecision` stamps the card so a refresh re-renders it with the same
// "Approved" / "Changes requested" / "Rejected" label instead of asking the
// user to decide again.

export type ApprovalDecision = "approved" | "changes_requested" | "rejected";

export type PersistedApprovalCard = {
  type: "approval_card";
  approvalId: string;
  contentId: string;
  title: string;
  contentType: string;
  stage: string;
  campaignName: string;
  rationale: string | null;
  preview: string;
  assetSignedUrl: string | null;
  videoSignedUrl: string | null;
  videoMimeType: string | null;
  videoDurationSec: number | null;
  requestedAt: string;
  decision?: ApprovalDecision;
};

// Practical ceiling so the localStorage entry doesn't grow unbounded for
// busy threads. Oldest (by requestedAt) get pruned first on overflow.
const MAX_PER_THREAD = 20;

function key(threadRef: string): string {
  return `test-chat:approvals:${threadRef}`;
}

export function loadApprovalCards(threadRef: string): PersistedApprovalCard[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key(threadRef));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is PersistedApprovalCard =>
        c && typeof c === "object" && typeof c.approvalId === "string",
    );
  } catch {
    return [];
  }
}

function save(threadRef: string, cards: PersistedApprovalCard[]): void {
  if (typeof window === "undefined") return;
  const trimmed =
    cards.length <= MAX_PER_THREAD
      ? cards
      : [...cards]
          .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
          .slice(0, MAX_PER_THREAD);
  try {
    window.localStorage.setItem(key(threadRef), JSON.stringify(trimmed));
  } catch {
    // localStorage full / disabled — drop silently. The in-memory copy
    // remains visible for this session.
  }
}

// Append unless we already have this approvalId, then save. Returns the
// updated list so callers can pass it straight to setState.
export function upsertApprovalCard(
  threadRef: string,
  current: PersistedApprovalCard[],
  incoming: Omit<PersistedApprovalCard, "decision">,
): PersistedApprovalCard[] {
  if (current.some((c) => c.approvalId === incoming.approvalId)) return current;
  const next = [...current, incoming];
  save(threadRef, next);
  return next;
}

export function setApprovalDecision(
  threadRef: string,
  current: PersistedApprovalCard[],
  approvalId: string,
  decision: ApprovalDecision,
): PersistedApprovalCard[] {
  let changed = false;
  const next = current.map((c) => {
    if (c.approvalId !== approvalId) return c;
    if (c.decision === decision) return c;
    changed = true;
    return { ...c, decision };
  });
  if (changed) save(threadRef, next);
  return next;
}
