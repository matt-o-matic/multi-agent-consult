import "server-only";

import { getServerEnv, requireOpenRouterApiKey } from "@/lib/env";
import type {
  NormalizedModel,
  RunConfig,
  SourceRecord,
} from "@/lib/types";
import type {
  ProviderAdapter,
  ProviderChatRequest,
  ProviderChatResponse,
} from "@/lib/providers/base";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const OPENROUTER_REQUEST_TIMEOUT_MS = 4 * 60 * 1000;

interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: {
    prompt?: string;
    completion?: string;
    web_search?: string;
  };
}

interface OpenRouterUsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenRouterStreamChunk {
  choices?: Array<{
    delta?: {
      content?: unknown;
      tool_calls?: unknown;
      annotations?: unknown;
    };
    annotations?: unknown;
    finish_reason?: string | null;
  }>;
  usage?: OpenRouterUsagePayload;
  error?: {
    message?: string;
  };
}

interface StreamingToolCallAccumulator {
  id: string;
  name: string;
  argumentsJson: string;
}

declare global {
  var __openRouterModelCache:
    | { fetchedAt: number; models: NormalizedModel[] }
    | undefined;
}

function parseContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part) {
          return String(part.text ?? "");
        }
        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}

function extractTextDelta(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part) {
          return String(part.text ?? "");
        }
        return "";
      })
      .join("");
  }

  return "";
}

function toUsage(usage?: OpenRouterUsagePayload | null) {
  return usage
    ? {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      }
    : null;
}

function mergeStreamingToolCalls(
  toolCalls: unknown,
  accumulators: Map<number, StreamingToolCallAccumulator>,
) {
  if (!Array.isArray(toolCalls)) {
    return;
  }

  for (const entry of toolCalls as Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>) {
    const index = typeof entry.index === "number" ? entry.index : accumulators.size;
    const existing = accumulators.get(index) ?? {
      id: entry.id ?? crypto.randomUUID(),
      name: entry.function?.name ?? "unknown_tool",
      argumentsJson: "",
    };

    if (entry.id) {
      existing.id = entry.id;
    }
    if (entry.function?.name) {
      existing.name = entry.function.name;
    }
    if (entry.function?.arguments) {
      existing.argumentsJson += entry.function.arguments;
    }

    accumulators.set(index, existing);
  }
}

function finalizeStreamingToolCalls(accumulators: Map<number, StreamingToolCallAccumulator>) {
  return [...accumulators.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, toolCall]) => {
      let parsedArguments: Record<string, unknown> = {};

      try {
        parsedArguments = toolCall.argumentsJson
          ? (JSON.parse(toolCall.argumentsJson) as Record<string, unknown>)
          : {};
      } catch {
        parsedArguments = {};
      }

      return {
        id: toolCall.id,
        name: toolCall.name,
        arguments: parsedArguments,
      };
    });
}

function toDomain(urlString: string) {
  try {
    return new URL(urlString).hostname;
  } catch {
    return "unknown";
  }
}

function normalizeModel(model: OpenRouterModel): NormalizedModel {
  const supportedParameters = model.supported_parameters ?? [];
  return {
    id: model.id,
    name: model.name ?? model.id,
    provider: "openrouter",
    description: model.description,
    contextLength: model.context_length,
    supportsTools:
      supportedParameters.includes("tools") ||
      supportedParameters.includes("tool_choice"),
    supportsStructuredOutput:
      supportedParameters.includes("response_format") ||
      supportedParameters.includes("structured_outputs"),
    supportsProviderNativeSearch:
      supportedParameters.includes("plugins") ||
      model.pricing?.web_search !== undefined,
    pricing: {
      prompt: model.pricing?.prompt,
      completion: model.pricing?.completion,
      webSearch: model.pricing?.web_search,
    },
  };
}

function parseToolCalls(toolCalls: unknown) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.map((toolCall) => {
    const call = toolCall as {
      id?: string;
      function?: { name?: string; arguments?: string };
    };

    let parsedArguments: Record<string, unknown> = {};
    try {
      parsedArguments = call.function?.arguments
        ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
        : {};
    } catch {
      parsedArguments = {};
    }

    return {
      id: call.id ?? crypto.randomUUID(),
      name: call.function?.name ?? "unknown_tool",
      arguments: parsedArguments,
    };
  });
}

export class OpenRouterAdapter implements ProviderAdapter {
  readonly key = "openrouter" as const;

  async listModels() {
    const cached = global.__openRouterModelCache;
    if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
      return cached.models;
    }

    const apiKey = requireOpenRouterApiKey();
    const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      next: { revalidate: 0 },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`OpenRouter models request failed: ${response.status}`);
    }

    const payload = (await response.json()) as { data?: OpenRouterModel[] };
    const models = (payload.data ?? []).map(normalizeModel).sort((a, b) => {
      return a.name.localeCompare(b.name);
    });

    global.__openRouterModelCache = {
      fetchedAt: Date.now(),
      models,
    };

    return models;
  }

  validateRoleCapabilities(config: RunConfig, models: NormalizedModel[]) {
    const errors: string[] = [];
    const modelMap = new Map(models.map((model) => [model.id, model]));

    const participantA = modelMap.get(config.participantA.modelId);
    const participantB = modelMap.get(config.participantB.modelId);
    const referee = modelMap.get(config.referee.modelId);

    if (!participantA) {
      errors.push(`Participant A model "${config.participantA.modelId}" is unavailable.`);
    } else if (!participantA.supportsTools) {
      errors.push(`Participant A model "${participantA.name}" does not support tool calling.`);
    }

    if (!participantB) {
      errors.push(`Participant B model "${config.participantB.modelId}" is unavailable.`);
    } else if (!participantB.supportsTools) {
      errors.push(`Participant B model "${participantB.name}" does not support tool calling.`);
    }

    if (!referee) {
      errors.push(`Referee model "${config.referee.modelId}" is unavailable.`);
    } else if (!referee.supportsStructuredOutput) {
      errors.push(
        `Referee model "${referee.name}" does not support structured JSON output.`,
      );
    }

    if (config.searchBackend === "provider_native") {
      if (!participantA?.supportsProviderNativeSearch) {
        errors.push(
          `Participant A model "${config.participantA.modelId}" does not support provider-native search.`,
        );
      }

      if (!participantB?.supportsProviderNativeSearch) {
        errors.push(
          `Participant B model "${config.participantB.modelId}" does not support provider-native search.`,
        );
      }
    }

    return errors;
  }

  async createChatStream(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    const apiKey = requireOpenRouterApiKey();
    const timeoutSignal = AbortSignal.timeout(OPENROUTER_REQUEST_TIMEOUT_MS);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;

    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: request.modelId,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
            tool_call_id: message.toolCallId,
            name: message.toolName,
            tool_calls: message.toolCalls?.map((toolCall) => ({
              id: toolCall.id,
              type: "function",
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.arguments),
              },
            })),
          })),
          tools: request.tools,
          tool_choice: request.tools?.length ? "auto" : undefined,
          plugins: request.plugins,
          response_format: request.responseFormat
            ? { type: request.responseFormat }
            : undefined,
          temperature: request.temperature ?? 0.4,
          stream: true,
        }),
        cache: "no-store",
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `OpenRouter completion failed: ${response.status} ${errorText}`,
        );
      }

      if (!response.body) {
        const payload = (await response.json()) as {
          choices?: Array<{
            message?: {
              content?: unknown;
              tool_calls?: unknown;
              annotations?: unknown;
            };
          }>;
          usage?: OpenRouterUsagePayload;
        };

        const choice = payload.choices?.[0]?.message;
        const rawAnnotations = choice?.annotations;
        const content = parseContent(choice?.content);
        if (content) {
          request.onTextDelta?.({ delta: content, content });
        }

        return {
          content,
          toolCalls: parseToolCalls(choice?.tool_calls),
          usage: toUsage(payload.usage),
          sources: this.normalizeSources(rawAnnotations),
          rawAnnotations,
        };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let usage: ProviderChatResponse["usage"] = null;
      let rawAnnotations: unknown;
      const toolCallAccumulators = new Map<number, StreamingToolCallAccumulator>();
      let isDone = false;

      while (!isDone) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const separatorIndex = buffer.indexOf("\n\n");
          if (separatorIndex === -1) {
            break;
          }

          const rawEvent = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);

          const payload = rawEvent
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");

          if (!payload) {
            continue;
          }

          if (payload === "[DONE]") {
            isDone = true;
            break;
          }

          const chunk = JSON.parse(payload) as OpenRouterStreamChunk;
          if (chunk.error?.message) {
            throw new Error(chunk.error.message);
          }

          usage = toUsage(chunk.usage) ?? usage;

          for (const choice of chunk.choices ?? []) {
            const delta = choice.delta;
            if (choice.annotations !== undefined) {
              rawAnnotations = choice.annotations;
            }
            if (delta?.annotations !== undefined) {
              rawAnnotations = delta.annotations;
            }
            if (!delta) {
              continue;
            }

            const textDelta = extractTextDelta(delta.content);
            if (textDelta) {
              content += textDelta;
              request.onTextDelta?.({ delta: textDelta, content });
            }

            mergeStreamingToolCalls(delta.tool_calls, toolCallAccumulators);
          }
        }
      }

      return {
        content,
        toolCalls: finalizeStreamingToolCalls(toolCallAccumulators),
        usage,
        sources: this.normalizeSources(rawAnnotations),
        rawAnnotations,
      };
    } catch (error) {
      if (timeoutSignal.aborted) {
        throw new Error(
          `OpenRouter completion timed out after ${OPENROUTER_REQUEST_TIMEOUT_MS / 1000} seconds.`,
        );
      }

      if (request.signal?.aborted) {
        throw request.signal.reason instanceof Error
          ? request.signal.reason
          : new Error("Run cancelled.");
      }

      throw error;
    }
  }

  async supportsProviderNativeSearch(modelId: string) {
    const models = await this.listModels();
    return models.some(
      (model) => model.id === modelId && model.supportsProviderNativeSearch,
    );
  }

  normalizeSources(
    rawAnnotations: unknown,
    context: { turnId?: string; toolInvocationId?: string } = {},
  ): SourceRecord[] {
    if (!Array.isArray(rawAnnotations)) {
      return [];
    }

    const normalized: SourceRecord[] = [];

    for (const annotation of rawAnnotations as unknown[]) {
      const payload = annotation as {
        url?: string;
        title?: string;
        content?: string;
        url_citation?: {
          url?: string;
          title?: string;
          text?: string;
        };
      };

      const citation = payload.url_citation ?? payload;
      const url = citation.url;
      if (!url) {
        continue;
      }

      normalized.push({
        id: crypto.randomUUID(),
        url,
        title: citation.title ?? url,
        domain: toDomain(url),
        snippet: payload.url_citation?.text ?? payload.content,
        sourceType: "web",
        toolInvocationId: context.toolInvocationId,
        turnId: context.turnId,
        createdAt: new Date().toISOString(),
      });
    }

    return normalized;
  }
}

export function getOpenRouterAdapter() {
  const { openRouterApiKey } = getServerEnv();
  if (!openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }
  return new OpenRouterAdapter();
}
