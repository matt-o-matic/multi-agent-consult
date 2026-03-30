import type {
  NormalizedModel,
  RunConfig,
  SourceRecord,
  TokenUsage,
} from "@/lib/types";

export type ProviderChatErrorKind =
  | "auth"
  | "cancelled"
  | "empty_response"
  | "invalid_request"
  | "not_found"
  | "provider_unavailable"
  | "rate_limited"
  | "sse_truncated"
  | "timeout_first_activity"
  | "timeout_idle"
  | "transport";

interface ProviderChatErrorOptions {
  cause?: unknown;
  kind: ProviderChatErrorKind;
  message: string;
  retryAfterMs?: number;
  retryable: boolean;
  statusCode?: number;
}

export class ProviderChatError extends Error {
  readonly kind: ProviderChatErrorKind;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(options: ProviderChatErrorOptions) {
    super(options.message);
    this.name = "ProviderChatError";
    this.kind = options.kind;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;

    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isProviderChatError(error: unknown): error is ProviderChatError {
  return error instanceof ProviderChatError;
}

export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ProviderToolCall[];
}

export interface ProviderToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ProviderChatRequest {
  modelId: string;
  messages: ProviderMessage[];
  tools?: ProviderToolDefinition[];
  responseFormat?: "json_object";
  plugins?: Array<Record<string, unknown>>;
  temperature?: number;
  signal?: AbortSignal;
  onTextDelta?: (payload: { delta: string; content: string }) => void;
}

export interface ProviderChatResponse {
  content: string;
  toolCalls: ProviderToolCall[];
  usage?: TokenUsage | null;
  sources?: SourceRecord[];
  rawAnnotations?: unknown;
}

export interface ProviderAdapter {
  key: "openrouter";
  listModels(): Promise<NormalizedModel[]>;
  validateRoleCapabilities(config: RunConfig, models: NormalizedModel[]): string[];
  createChatStream(request: ProviderChatRequest): Promise<ProviderChatResponse>;
  supportsProviderNativeSearch(modelId: string): Promise<boolean>;
  normalizeSources(
    rawAnnotations: unknown,
    context?: {
      turnId?: string;
      toolInvocationId?: string;
    },
  ): SourceRecord[];
}
