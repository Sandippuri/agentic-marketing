"use client";

import { useState, useTransition } from "react";
import type { LearningSummary } from "@/lib/learning/aggregate";

export type LessonsDoc = {
  id: string;
  slug: string;
  title: string;
  body: string;
  updatedAt: string;
};

const WINDOWS = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
];

export function LearningClient({
  windowDays,
  summary,
  lessons,
}: {
  windowDays: number;
  summary: LearningSummary;
  lessons: LessonsDoc | null;
}) {
  const [pending, startTransition] = useTransition();
  const [synthMessage, setSynthMessage] = useState<string | null>(null);

  async function runSynthesis() {
    setSynthMessage(null);
    const res = await fetch(`/api/learning/synthesis`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ windowDays }),
    });
    if (!res.ok) {
      setSynthMessage(`Failed: ${res.status} ${await res.text()}`);
      return;
    }
    const json = (await res.json()) as { runId: string };
    setSynthMessage(
      `Synthesis run started (${json.runId.slice(0, 8)}). Refresh in ~30s to see updated lessons.`,
    );
  }

  const totals = summary.totals;
  const approvalPct = (totals.approvalRate * 100).toFixed(0);
  const rejectionPct = (totals.rejectionRate * 100).toFixed(0);
  const changesPct = (totals.changesRate * 100).toFixed(0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        {WINDOWS.map((w) => (
          <a
            key={w.value}
            href={`/learning?windowDays=${w.value}`}
            className={[
              "rounded-md px-3 py-1.5 text-[12px]",
              w.value === windowDays
                ? "bg-[var(--accent)] text-white"
                : "bg-[var(--surface-2)] text-mid hover:text-ink",
            ].join(" ")}
          >
            {w.label}
          </a>
        ))}
        <div className="ml-auto">
          <button
            onClick={() => startTransition(runSynthesis)}
            disabled={pending}
            className="rounded-md px-3 py-1.5 text-[12px] bg-[var(--accent)] text-white"
          >
            {pending ? "Synthesising…" : "Synthesise now"}
          </button>
        </div>
      </div>

      {synthMessage && (
        <div className="surface p-3 text-[13px] text-mid">{synthMessage}</div>
      )}

      <div className="grid grid-cols-4 gap-3">
        <Stat
          label="Decisions"
          value={String(totals.decisions)}
          sub={`window: ${windowDays}d`}
        />
        <Stat
          label="Approval rate"
          value={`${approvalPct}%`}
          sub={`${totals.approved} / ${totals.decisions}`}
          tone="good"
        />
        <Stat
          label="Changes requested"
          value={`${changesPct}%`}
          sub={`${totals.changes_requested} drafts`}
          tone="warn"
        />
        <Stat
          label="Rejection rate"
          value={`${rejectionPct}%`}
          sub={`${totals.rejected} drafts`}
          tone="bad"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <section className="surface p-4">
          <h2 className="section-title mb-2">Edit distance — approved drafts</h2>
          {summary.editDistance.count === 0 ? (
            <p className="text-mid text-[13px]">
              No approved drafts in this window yet.
            </p>
          ) : (
            <dl className="grid grid-cols-3 gap-3 text-[13px]">
              <div>
                <dt className="text-faint text-[11px]">avg</dt>
                <dd className="text-ink">
                  {summary.editDistance.avg?.toFixed(0) ?? "n/a"}
                </dd>
              </div>
              <div>
                <dt className="text-faint text-[11px]">p50</dt>
                <dd className="text-ink">
                  {summary.editDistance.p50?.toFixed(0) ?? "n/a"}
                </dd>
              </div>
              <div>
                <dt className="text-faint text-[11px]">p90</dt>
                <dd className="text-ink">
                  {summary.editDistance.p90?.toFixed(0) ?? "n/a"}
                </dd>
              </div>
            </dl>
          )}
          <p className="text-faint text-[11px] mt-2">
            Levenshtein distance between AI draft and human-final body. Lower is
            better.
          </p>
        </section>

        <section className="surface p-4">
          <h2 className="section-title mb-2">By channel</h2>
          {summary.byChannel.length === 0 ? (
            <p className="text-mid text-[13px]">
              No channel-tagged feedback yet (need a publish_jobs row to
              attribute to a channel).
            </p>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-faint">
                  <th className="text-left font-normal">Channel</th>
                  <th className="text-right font-normal">Approved</th>
                  <th className="text-right font-normal">Changes</th>
                  <th className="text-right font-normal">Rejected</th>
                  <th className="text-right font-normal">Approval %</th>
                </tr>
              </thead>
              <tbody>
                {summary.byChannel.map((c) => (
                  <tr key={c.channel} className="border-t border-[var(--border)]">
                    <td className="py-1.5">{c.channel}</td>
                    <td className="py-1.5 text-right">{c.approved}</td>
                    <td className="py-1.5 text-right">{c.changes}</td>
                    <td className="py-1.5 text-right">{c.rejected}</td>
                    <td className="py-1.5 text-right">
                      {(c.approvalRate * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="surface p-4">
        <h2 className="section-title mb-2">Top rejection / change reasons</h2>
        {summary.topReasons.length === 0 ? (
          <p className="text-mid text-[13px]">No reasons captured yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {summary.topReasons.map((r, i) => (
              <li key={i} className="rounded-md p-2 bg-[var(--surface-2)]">
                <div className="flex items-baseline gap-2">
                  <span className="text-faint text-[11px] mono">
                    ×{r.count}
                  </span>
                  <span className="text-faint text-[11px]">
                    {r.decision === "rejected" ? "rejected" : "changes"}
                  </span>
                </div>
                <div className="text-[13px] text-ink mt-1">{r.reason}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="surface p-4">
        <h2 className="section-title mb-2">Recent rejections</h2>
        {summary.recentRejections.length === 0 ? (
          <p className="text-mid text-[13px]">None in this window.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {summary.recentRejections.map((r) => (
              <li
                key={r.feedbackId}
                className="rounded-md p-2 bg-[var(--surface-2)] text-[12px]"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-faint">
                    {new Date(r.decidedAt).toLocaleString()}
                  </span>
                  <span className="text-faint">·</span>
                  <span className="text-faint">{r.decision}</span>
                  {r.editDistance != null && (
                    <>
                      <span className="text-faint">·</span>
                      <span className="text-faint">
                        edit distance {r.editDistance}
                      </span>
                    </>
                  )}
                </div>
                <div className="text-ink mt-0.5 font-medium">
                  {r.contentTitle}
                </div>
                <div className="text-mid mt-0.5 line-clamp-2">
                  {r.reason ?? "(no reason)"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="surface p-4">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="section-title">Synthesised lessons (active in KB)</h2>
          {lessons && (
            <span className="text-faint text-[11px]">
              updated {new Date(lessons.updatedAt).toLocaleString()}
            </span>
          )}
        </div>
        {!lessons ? (
          <p className="text-mid text-[13px]">
            No lessons synthesised yet. Click "Synthesise now" once you have at
            least 5 decisions in the window — the workflow distils themes and
            writes them to the KB so future agents pick them up.
          </p>
        ) : (
          <article className="text-[13px] text-ink whitespace-pre-wrap mono">
            {lessons.body}
          </article>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "good" | "warn" | "bad";
}) {
  const accent =
    tone === "good"
      ? "text-[var(--success)]"
      : tone === "warn"
        ? "text-[var(--warn)]"
        : tone === "bad"
          ? "text-[var(--danger)]"
          : "text-ink";
  return (
    <div className="surface p-4 flex flex-col gap-1">
      <div className="text-faint text-[11px] uppercase tracking-wide">
        {label}
      </div>
      <div className={`text-[22px] font-semibold ${accent}`}>{value}</div>
      <div className="text-faint text-[11px]">{sub}</div>
    </div>
  );
}
