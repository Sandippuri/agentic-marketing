import { eq } from "drizzle-orm";
import { getDb, schema } from "@marketing/db";
import { generateImage } from "@marketing/agents/image-gen";
import { uploadGeneratedMedia } from "@marketing/agents/asset-uploader";
import {
  resolveImageModel,
  type AssetKind,
  type ImageModel,
  type LlmModel,
} from "@marketing/shared-types";
import { finishRun } from "@/lib/workflow-engines/runs";

// Vercel asset-only workflow. Wraps a single image generation as one
// durable step so the dashboard sees the same workflow_runs lifecycle as
// campaign-plan / single-post. Unlike the Custom engine (which runs the
// asset sub-agent's full tool loop with brand memory + design system + Veo
// video), this one is a no-LLM direct image-gen call against the
// Settings-configured image model — fast and predictable.

const DEFAULT_ASSET_KIND: AssetKind = "hero";

export type AssetInput = {
  request: string;
  contentId?: string;
  /** Override the default "hero" kind (e.g. "poster", "og"). */
  kind?: AssetKind;
  /** Image aspect ratio. Defaults to "square". */
  aspect?: "square" | "portrait" | "landscape" | "wide" | "tall";
  userId?: string;
  threadRef?: string;
  // The asset workflow doesn't currently use an LLM, but we accept and
  // ignore `model` so the engine adapter can pass through the same
  // StartInput shape used by single-post / campaign-plan.
  model?: LlmModel;
  // Set by lib/workflow-engines so the workflow body can finalise the
  // matching workflow_runs row when generation completes.
  workflowRunId?: string;
};

export type AssetOutput = {
  assetId: string;
  storagePath: string;
  status: "completed" | "failed";
};

export async function assetWorkflow(input: AssetInput): Promise<AssetOutput> {
  "use workflow";

  try {
    const result = await generateAndStoreAssetStep(input);
    await finishWorkflowRunStep({
      workflowRunId: input.workflowRunId,
      status: "completed",
    });
    return { ...result, status: "completed" };
  } catch (err) {
    const message = (err as Error).message;
    await finishWorkflowRunStep({
      workflowRunId: input.workflowRunId,
      status: "failed",
      error: message,
    });
    throw err;
  }
}

async function generateAndStoreAssetStep(
  input: AssetInput,
): Promise<{ assetId: string; storagePath: string }> {
  "use step";

  const model = await loadConfiguredImageModel();
  const aspect = input.aspect ?? "square";
  const kind = input.kind ?? DEFAULT_ASSET_KIND;

  const prompt = input.request.trim();
  if (!prompt) {
    throw new Error("asset workflow requires a non-empty request");
  }

  const image = await generateImage({ prompt, aspect, model });
  const ext = (image.mimeType.split("/")[1] ?? "png").toLowerCase();
  const dir = input.contentId ? `variants/${input.contentId}` : "standalone";
  const { storagePath } = await uploadGeneratedMedia(
    image,
    `${dir}/${crypto.randomUUID()}.${ext}`,
  );

  const db = getDb();
  const [row] = await db
    .insert(schema.assets)
    .values({
      contentId: input.contentId ?? null,
      kind,
      storagePath,
      promptUsed: prompt,
      mimeType: image.mimeType,
      status: "draft",
    })
    .returning({ id: schema.assets.id });

  return { assetId: row!.id, storagePath };
}

async function loadConfiguredImageModel(): Promise<ImageModel> {
  // Read the Settings-configured image model. Same pattern as
  // lib/asset-variants — keep them aligned.
  try {
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "image_model"))
      .limit(1);
    return resolveImageModel(row?.value);
  } catch {
    return resolveImageModel(undefined);
  }
}

async function finishWorkflowRunStep(payload: {
  workflowRunId?: string;
  status: "completed" | "failed" | "cancelled";
  error?: string | null;
}): Promise<void> {
  "use step";
  if (!payload.workflowRunId) return;
  await finishRun(payload.workflowRunId, {
    status: payload.status,
    error: payload.error ?? null,
  });
}
