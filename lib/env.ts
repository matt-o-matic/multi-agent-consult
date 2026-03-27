import "server-only";

export function getServerEnv() {
  return {
    openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
    braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY ?? "",
  };
}

export function requireOpenRouterApiKey() {
  const { openRouterApiKey } = getServerEnv();
  if (!openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }
  return openRouterApiKey;
}
