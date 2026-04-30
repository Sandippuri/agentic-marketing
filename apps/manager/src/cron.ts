// Weekly analyst cron — fires every Monday at 09:00 Asia/Kathmandu (UTC+5:45 → 03:15 UTC).
// Uses a simple setInterval loop rather than BullMQ repeatable jobs so the
// Manager process doesn't need a queue dependency for scheduling.
// Swap to BullMQ Worker + repeatable job if you want distributed guarantees.

import pino from "pino";
import type { CpClient } from "@marketing/cp-client";
import { runAnalyst } from "./sub-agents/analyst";

const log = pino({ name: "cron" });

const KATHMANDU_OFFSET_MINUTES = 5 * 60 + 45; // UTC+5:45

/** Returns the next Monday 09:00 Kathmandu time as a UTC Date. */
function nextMondayKathmandu(): Date {
  const now = new Date();
  // Shift to Kathmandu "virtual local time".
  const ktmMs = now.getTime() + KATHMANDU_OFFSET_MINUTES * 60_000;
  const ktm = new Date(ktmMs);

  // Days until next Monday: 0=Sun,1=Mon,...,6=Sat
  const day = ktm.getUTCDay(); // 0=Sun in UTC = same in KTM
  const daysUntilMon = day === 1 ? 7 : (8 - day) % 7; // 7 if already Monday (next week)

  const target = new Date(ktm);
  target.setUTCDate(ktm.getUTCDate() + daysUntilMon);
  target.setUTCHours(9, 0, 0, 0); // 09:00 KTM = 03:15 UTC

  // Convert back to UTC by subtracting the KTM offset.
  return new Date(target.getTime() - KATHMANDU_OFFSET_MINUTES * 60_000);
}

async function runWeeklyReport(cp: CpClient, notifyFn: (msg: string) => Promise<void>) {
  log.info("weekly analyst report starting");
  try {
    const report = await runAnalyst({
      request: [
        "Summarize last week's marketing performance.",
        "Include: which channels drove the most output, any notable publish failures,",
        "which content stage had the highest throughput.",
        "Recommend one concrete change for next week.",
        "Then write the findings to learnings/{yyyy-mm}.md.",
      ].join(" "),
      cp,
    });
    await notifyFn(report);
    log.info("weekly analyst report posted");
  } catch (err) {
    log.error({ err: (err as Error).message }, "weekly analyst report failed");
    await notifyFn("⚠️ Weekly report failed — check manager logs.").catch(() => null);
  }
}

/** Start the Monday cron. `notifyFn` should post to #marketing. */
export function startWeeklyCron(cp: CpClient, notifyFn: (msg: string) => Promise<void>) {
  function schedule() {
    const next = nextMondayKathmandu();
    const delay = next.getTime() - Date.now();
    log.info({ nextRun: next.toISOString(), delayHours: (delay / 3.6e6).toFixed(1) }, "weekly cron scheduled");

    setTimeout(async () => {
      await runWeeklyReport(cp, notifyFn);
      schedule(); // reschedule after each run
    }, delay);
  }

  schedule();
}
