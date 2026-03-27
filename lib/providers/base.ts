import type {
  NormalizedModel,
  RunConfig,
  SourceRecord,
  TokenUsage,
} from "@/lib/types";

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
