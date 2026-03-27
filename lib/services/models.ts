import "server-only";

import { getServerEnv } from "@/lib/env";
import { getOpenRouterAdapter } from "@/lib/providers/openrouter";
import type { NormalizedModel, RunConfig } from "@/lib/types";

export async function getAvailableModels() {
  const { openRouterApiKey, braveSearchApiKey } = getServerEnv();
  if (!openRouterApiKey) {
    return {
      configured: false,
      braveConfigured: !!braveSearchApiKey,
      models: [] as NormalizedModel[],
      errors: ["OPENROUTER_API_KEY is not configured."],
    };
  }

  const adapter = getOpenRouterAdapter();
  const models = await adapter.listModels();

  return {
    configured: true,
    braveConfigured: !!braveSearchApiKey,
    models,
    errors: [] as string[],
  };
}

export async function validateRunConfig(config: RunConfig) {
  const adapter = getOpenRouterAdapter();
  const models = await adapter.listModels();
  return {
    adapter,
    models,
    errors: adapter.validateRoleCapabilities(config, models),
  };
}
