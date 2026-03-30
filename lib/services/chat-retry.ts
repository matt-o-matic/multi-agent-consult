import "server-only";

import {
  isProviderChatError,
  ProviderChatError,
} from "@/lib/providers/base";

const CHAT_COMPLETION_ATTEMPTS = 3;
const CHAT_COMPLETION_BACKOFF_MS = [2_000, 8_000] as const;
const CHAT_COMPLETION_MAX_RETRY_AFTER_MS = 30_000;

type RetryableAttemptError = {
  message: string;
  retryAfterMs?: number;
  retryable: boolean;
};

export class RetryableStructuredOutputError extends Error {
  readonly retryAfterMs: number;
  readonly retryable = true;

  constructor(message: string, retryAfterMs = 0) {
    super(message);
    this.name = "RetryableStructuredOutputError";
    this.retryAfterMs = retryAfterMs;
  }
}

interface ChatAttemptContext {
  attempt: number;
  maxAttempts: number;
}

type AttemptStartPayload = ChatAttemptContext;

interface AttemptRetryPayload extends ChatAttemptContext {
  lastError: string;
  retryDelayMs: number;
}

interface ExecuteChatWithRetryArgs<T> {
  execute: (context: ChatAttemptContext) => Promise<T>;
  label: string;
  maxAttempts?: number;
  onAttemptRetry?: (payload: AttemptRetryPayload) => void;
  onAttemptStart?: (payload: AttemptStartPayload) => void;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) {
    return;
  }

  throw signal.reason instanceof Error ? signal.reason : new Error("Run cancelled.");
}

function toRetryableAttemptError(error: unknown): RetryableAttemptError | null {
  if (isProviderChatError(error)) {
    return error.retryable ? error : null;
  }

  if (error instanceof RetryableStructuredOutputError) {
    return error;
  }

  return null;
}

function getRetryDelayMs(error: RetryableAttemptError, attempt: number) {
  if (typeof error.retryAfterMs === "number") {
    return Math.max(
      0,
      Math.min(CHAT_COMPLETION_MAX_RETRY_AFTER_MS, Math.round(error.retryAfterMs)),
    );
  }

  const index = Math.max(0, Math.min(CHAT_COMPLETION_BACKOFF_MS.length - 1, attempt - 1));
  return CHAT_COMPLETION_BACKOFF_MS[index];
}

async function sleep(delayMs: number, signal?: AbortSignal) {
  throwIfAborted(signal);

  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Run cancelled."));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function wrapAttemptFailure(label: string, attempts: number, error: unknown) {
  const lastMessage =
    error instanceof Error ? error.message : "Unknown model completion failure";
  const wrapped = new Error(
    `${label} failed after ${attempts} attempt${attempts === 1 ? "" : "s"}. Last error: ${lastMessage}`,
  );
  (wrapped as Error & { cause?: unknown }).cause = error;
  return wrapped;
}

export async function executeChatWithRetry<T>({
  execute,
  label,
  maxAttempts = CHAT_COMPLETION_ATTEMPTS,
  onAttemptRetry,
  onAttemptStart,
  signal,
}: ExecuteChatWithRetryArgs<T>) {
  let attempt = 1;

  while (attempt <= maxAttempts) {
    throwIfAborted(signal);
    onAttemptStart?.({
      attempt,
      maxAttempts,
    });

    try {
      return await execute({
        attempt,
        maxAttempts,
      });
    } catch (error) {
      throwIfAborted(signal);

      const retryable = toRetryableAttemptError(error);
      if (!retryable) {
        if (attempt > 1) {
          throw wrapAttemptFailure(label, attempt, error);
        }

        throw error;
      }

      if (attempt >= maxAttempts) {
        throw wrapAttemptFailure(label, attempt, error);
      }

      const retryDelayMs = getRetryDelayMs(retryable, attempt);
      onAttemptRetry?.({
        attempt: attempt + 1,
        maxAttempts,
        lastError: retryable.message,
        retryDelayMs,
      });

      await sleep(retryDelayMs, signal);
      attempt += 1;
    }
  }

  throw new ProviderChatError({
    kind: "provider_unavailable",
    message: `${label} exhausted its retry budget.`,
    retryable: false,
  });
}
