// GET /api/workflow-runs/engines
//
// Returns the engine catalogue (id, label, description, available, kinds)
// so the picker UI can render without hardcoding the list. The page can
// also import listEngineDescriptors() directly server-side; this route
// exists for client components that want a hot refresh after toggling
// availability via env/feature flags.

import { listEngineDescriptors } from "@/lib/workflow-engines";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ engines: listEngineDescriptors() });
}
