import {
  DEFAULT_LLM_MODEL,
  LLM_MODELS,
  PROVIDER_LABELS,
  type LlmProvider,
} from "@marketing/shared-types";

function providerHasKey(provider: LlmProvider): boolean {
  switch (provider) {
    case "anthropic":
      return !!process.env.ANTHROPIC_API_KEY;
    case "openai":
      return !!process.env.OPENAI_API_KEY;
    case "google":
      return !!(
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY
      );
  }
}

export async function GET() {
  const available = LLM_MODELS.filter((m) => providerHasKey(m.provider));
  const defaultId = available.some((m) => m.id === DEFAULT_LLM_MODEL)
    ? DEFAULT_LLM_MODEL
    : available[0]?.id;

  return Response.json({
    default: defaultId,
    providerLabels: PROVIDER_LABELS,
    models: available,
  });
}
