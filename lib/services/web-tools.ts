import "server-only";

import { load } from "cheerio";
import { htmlToText } from "html-to-text";

import { getServerEnv } from "@/lib/env";
import { getOpenRouterAdapter } from "@/lib/providers/openrouter";
import { executeChatWithRetry } from "@/lib/services/chat-retry";
import type { SourceRecord } from "@/lib/types";

const USER_AGENT = "multi-agent-consult/0.1 (+local)";

function toDomain(urlString: string) {
  try {
    return new URL(urlString).hostname;
  } catch {
    return "unknown";
  }
}

function limitText(input: string, maxLength = 6000) {
  return input.length <= maxLength ? input : `${input.slice(0, maxLength)}...`;
}

export async function braveSearch(query: string) {
  const { braveSearchApiKey } = getServerEnv();
  if (!braveSearchApiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY is not configured.");
  }

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": braveSearchApiKey,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`Brave search failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    web?: {
      results?: Array<{
        url: string;
        title?: string;
        description?: string;
      }>;
    };
  };

  const sources = (payload.web?.results ?? []).map((result) => ({
    id: crypto.randomUUID(),
    url: result.url,
    title: result.title ?? result.url,
    domain: toDomain(result.url),
    snippet: result.description,
    sourceType: "web" as const,
    createdAt: new Date().toISOString(),
  }));

  return {
    summary:
      sources.length === 0
        ? "No web results found."
        : sources
            .map((source, index) => `${index + 1}. ${source.title} (${source.url})`)
            .join("\n"),
    sources,
  };
}

export async function openRouterNativeSearch(
  query: string,
  modelId: string,
  signal?: AbortSignal,
) {
  const adapter = getOpenRouterAdapter();
  const response = await executeChatWithRetry({
    label: `Provider-native search with ${modelId}`,
    signal,
    execute: () =>
      adapter.createChatStream({
        modelId,
        messages: [
          {
            role: "system",
            content:
              "Search the web for the user's query and return a concise fact-focused summary. Include only supported, current information.",
          },
          {
            role: "user",
            content: query,
          },
        ],
        plugins: [{ id: "web", engine: "native" }],
        temperature: 0.1,
        signal,
      }),
  });

  return {
    summary: response.content,
    sources: response.sources ?? [],
  };
}

export async function fetchWebPage(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Could not fetch page: ${response.status}`);
  }

  const html = await response.text();
  const $ = load(html);
  $("script, style, noscript").remove();
  const title = $("title").first().text().trim() || url;
  const contentNode = $("main").first().html() || $("article").first().html() || $("body").html() || "";

  const text = htmlToText(contentNode, {
    wordwrap: false,
    selectors: [{ selector: "a", options: { ignoreHref: true } }],
  });

  const source = {
    id: crypto.randomUUID(),
    url,
    title,
    domain: toDomain(url),
    snippet: limitText(text.replace(/\n{3,}/g, "\n\n").trim(), 1200),
    sourceType: "web" as const,
    createdAt: new Date().toISOString(),
  } satisfies SourceRecord;

  return {
    title,
    url,
    content: limitText(text.trim()),
    sources: [source],
  };
}
