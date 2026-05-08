// Cloudflare Workflows adapter — registered as a stub so the picker can
// surface it as "coming soon". When you implement it, flip
// capability.available to true, fill in start(), and add the kinds it can
// run. No UI or dispatcher changes required.

import type { WorkflowEngine } from "../types";

export const cloudflareEngine: WorkflowEngine = {
  id: "cloudflare",
  label: "Cloudflare",
  description: "Cloudflare Workflows runtime (coming soon).",
  capability: {
    available: false,
    kinds: [],
    supportsContentRevision: false,
  },

  async start() {
    throw new Error("cloudflare engine not implemented yet");
  },
};
