"use client";

import { useMemo, useState } from "react";
import { ApprovalRow, type PendingApproval } from "./approval-row";
import { ApprovalDetailPanel } from "./approval-detail-panel";
import { BatchApproveButton } from "./batch-approve-button";
import { Badge } from "../ui";

type Group = {
  campaignId: string;
  name: string;
  approvals: PendingApproval[];
};

export function ApprovalsShell({ groups }: { groups: Group[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Look up the live approval object so the panel always reflects the latest
  // server-rendered state after refresh.
  const selected = useMemo(() => {
    if (!selectedId) return null;
    for (const g of groups) {
      const found = g.approvals.find((a) => a.id === selectedId);
      if (found) return found;
    }
    return null;
  }, [groups, selectedId]);

  return (
    <>
      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.campaignId} className="surface">
            <header className="flex items-center justify-between gap-3 px-5 py-3 hairline-b">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="grid place-items-center h-7 w-7 rounded-md bg-[var(--accent-soft)] text-[var(--accent)] shrink-0">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 11l18-7v16L3 13z" />
                  </svg>
                </span>
                <h2 className="text-sm font-semibold text-ink truncate">{group.name}</h2>
                <Badge tone="neutral">{group.approvals.length}</Badge>
              </div>
              {group.approvals.length > 1 && (
                <BatchApproveButton approvalIds={group.approvals.map((a) => a.id)} />
              )}
            </header>
            <ul className="divide-y divide-[var(--border)]">
              {group.approvals.map((a) => (
                <ApprovalRow
                  key={a.id}
                  approval={a}
                  isSelected={a.id === selectedId}
                  onOpen={() => setSelectedId(a.id)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <ApprovalDetailPanel approval={selected} onClose={() => setSelectedId(null)} />
    </>
  );
}
