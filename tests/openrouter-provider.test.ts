import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderChatError } from "@/lib/providers/base";
import { OpenRouterAdapter } from "@/lib/providers/openrouter";
import type { ProviderChatRequest } from "@/lib/providers/base";
import type { RunConfig } from "@/lib/types";

const baseConfig: RunConfig = {
  taskPrompt: "Solve the issue.",
  maxTurns: 3,
  searchBackend: "provider_native",
  workspaceMode: "off",
  workspacePath: null,
  participantA: {
    role: "participant_a",
    modelId: "alpha",
    provider: "openrouter",
    label: "Participant A",
  },
  participantB: {
    role: "participant_b",
    modelId: "beta",
    provider: "openrouter",
    label: "Participant B",
  },
  referee: {
    role: "referee",
    modelId: "gamma",
    provider: "openrouter",
    label: "Referee",
  },
};

function createRequest(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    modelId: "openai/gpt-5.4-mini",
    messages: [
      {
        role: "user",
        content: "Test the timeout behavior.",
      },
    ],
    ...overrides,
  };
}

function sseEvent(payload: string) {
  return `data: ${payload}\n\n`;
}

function createStreamingResponse(
  signal: AbortSignal,
  events: Array<{ atMs: number; chunk: string; closeAfter?: boolean }>,
) {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let settled = false;

        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener("abort", onAbort);
          controller.close();
        };

        const fail = (reason?: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener("abort", onAbort);
          controller.error(reason ?? new Error("Aborted."));
        };

        const onAbort = () => {
          fail(signal.reason);
        };

        signal.addEventListener("abort", onAbort, { once: true });

        for (const event of events) {
          setTimeout(() => {
            if (settled) {
              return;
            }

            controller.enqueue(encoder.encode(event.chunk));

            if (event.closeAfter) {
              finish();
            }
          }, event.atMs);
        }
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
      },
    },
  );
}

describe("OpenRouterAdapter.validateRoleCapabilities", () => {
  it("rejects missing tool and structured-output support", () => {
    const adapter = new OpenRouterAdapter();
    const errors = adapter.validateRoleCapabilities(baseConfig, [
      {
        id: "alpha",
        name: "Alpha",
        provider: "openrouter",
        supportsTools: false,
        supportsStructuredOutput: false,
        supportsProviderNativeSearch: false,
      },
      {
        id: "beta",
        name: "Beta",
        provider: "openrouter",
        supportsTools: true,
        supportsStructuredOutput: false,
        supportsProviderNativeSearch: false,
      },
      {
        id: "gamma",
        name: "Gamma",
        provider: "openrouter",
        supportsTools: false,
        supportsStructuredOutput: false,
        supportsProviderNativeSearch: false,
      },
    ]);

    expect(errors).toContain('Participant A model "Alpha" does not support tool calling.');
    expect(errors).toContain(
      'Referee model "Gamma" does not support structured JSON output.',
    );
    expect(errors).toContain(
      'Participant B model "beta" does not support provider-native search.',
    );
  });
});

describe("OpenRouterAdapter.createChatStream", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("allows the first streamed activity to arrive just before 60 seconds", async () => {
    const fetchMock = vi.fn((_, init?: RequestInit) => {
      return Promise.resolve(
        createStreamingResponse(init?.signal as AbortSignal, [
          {
            atMs: 59_000,
            chunk: sseEvent(
              JSON.stringify({
                choices: [
                  {
                    delta: {
                      content: "Hello",
                    },
                  },
                ],
              }),
            ),
          },
          {
            atMs: 59_500,
            chunk: sseEvent("[DONE]"),
            closeAfter: true,
          },
        ]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenRouterAdapter();
    const deltas: string[] = [];
    const responsePromise = adapter.createChatStream(
      createRequest({
        onTextDelta: ({ delta }) => {
          deltas.push(delta);
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(59_500);
    const response = await responsePromise;

    expect(response.content).toBe("Hello");
    expect(deltas).toEqual(["Hello"]);
  });

  it("times out if no streamed activity arrives within 60 seconds", async () => {
    const fetchMock = vi.fn((_, init?: RequestInit) => {
      return Promise.resolve(createStreamingResponse(init?.signal as AbortSignal, []));
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenRouterAdapter();
    const responsePromise = adapter.createChatStream(createRequest());
    const failure = expect(responsePromise).rejects.toThrow(
      "OpenRouter completion timed out waiting for first streamed activity after 60 seconds.",
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await failure;
  });

  it("classifies 429 responses as retryable and honors Retry-After", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response("rate limited", {
          status: 429,
          headers: {
            "Retry-After": "12",
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenRouterAdapter();

    await expect(adapter.createChatStream(createRequest())).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 12_000,
      retryable: true,
      statusCode: 429,
    } satisfies Partial<ProviderChatError>);
  });

  it("does not mark 400 responses as retryable", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response("bad request", {
          status: 400,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenRouterAdapter();

    await expect(adapter.createChatStream(createRequest())).rejects.toMatchObject({
      kind: "invalid_request",
      retryable: false,
      statusCode: 400,
    } satisfies Partial<ProviderChatError>);
  });

  it("times out after 30 seconds without streamed activity once the stream has started", async () => {
    const fetchMock = vi.fn((_, init?: RequestInit) => {
      return Promise.resolve(
        createStreamingResponse(init?.signal as AbortSignal, [
          {
            atMs: 0,
            chunk: sseEvent(
              JSON.stringify({
                choices: [
                  {
                    delta: {
                      content: "Hi",
                    },
                  },
                ],
              }),
            ),
          },
        ]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenRouterAdapter();
    const responsePromise = adapter.createChatStream(createRequest());
    const failure = expect(responsePromise).rejects.toThrow(
      "OpenRouter completion timed out after 30 seconds without streamed activity.",
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
  });

  it("treats non-text streamed events as activity and still resolves tool calls", async () => {
    const fetchMock = vi.fn((_, init?: RequestInit) => {
      return Promise.resolve(
        createStreamingResponse(init?.signal as AbortSignal, [
          {
            atMs: 0,
            chunk: sseEvent(
              JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "tool-1",
                          function: {
                            name: "web_search",
                            arguments: "{\"query\":\"kimi\"}",
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
            ),
          },
          {
            atMs: 20_000,
            chunk: sseEvent(
              JSON.stringify({
                usage: {
                  total_tokens: 42,
                },
              }),
            ),
          },
          {
            atMs: 25_000,
            chunk: sseEvent("[DONE]"),
            closeAfter: true,
          },
        ]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenRouterAdapter();
    const responsePromise = adapter.createChatStream(createRequest());

    await vi.advanceTimersByTimeAsync(25_000);
    const response = await responsePromise;

    expect(response.content).toBe("");
    expect(response.toolCalls).toEqual([
      {
        id: "tool-1",
        name: "web_search",
        arguments: {
          query: "kimi",
        },
      },
    ]);
    expect(response.usage?.totalTokens).toBe(42);
  });

  it("treats invalid streamed JSON payloads as retryable stream errors", async () => {
    const fetchMock = vi.fn((_, init?: RequestInit) => {
      return Promise.resolve(
        createStreamingResponse(init?.signal as AbortSignal, [
          {
            atMs: 0,
            chunk: sseEvent("{not-json"),
          },
        ]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenRouterAdapter();

    const responsePromise = adapter.createChatStream(createRequest());
    const failure = expect(responsePromise).rejects.toMatchObject({
      kind: "sse_truncated",
      retryable: true,
    } satisfies Partial<ProviderChatError>);
    await vi.runAllTimersAsync();
    await failure;
  });

  it("treats empty streamed completions as retryable", async () => {
    const fetchMock = vi.fn((_, init?: RequestInit) => {
      return Promise.resolve(
        createStreamingResponse(init?.signal as AbortSignal, [
          {
            atMs: 0,
            chunk: sseEvent("[DONE]"),
            closeAfter: true,
          },
        ]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenRouterAdapter();
    const responsePromise = adapter.createChatStream(createRequest());
    const failure = expect(responsePromise).rejects.toMatchObject({
      kind: "empty_response",
      retryable: true,
    } satisfies Partial<ProviderChatError>);
    await vi.runAllTimersAsync();
    await failure;
  });

  it("allows a stream with regular activity to run well past four minutes", async () => {
    const events = Array.from({ length: 10 }, (_, index) => ({
      atMs: index * 29_000,
      chunk: sseEvent(
        JSON.stringify({
          choices: [
            {
              delta: {
                content: `chunk-${index}`,
              },
            },
          ],
        }),
      ),
    }));

    const fetchMock = vi.fn((_, init?: RequestInit) => {
      return Promise.resolve(
        createStreamingResponse(init?.signal as AbortSignal, [
          ...events,
          {
            atMs: 10 * 29_000,
            chunk: sseEvent("[DONE]"),
            closeAfter: true,
          },
        ]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenRouterAdapter();
    const responsePromise = adapter.createChatStream(createRequest());

    await vi.advanceTimersByTimeAsync(290_000);
    const response = await responsePromise;

    expect(response.content).toContain("chunk-0");
    expect(response.content).toContain("chunk-9");
  });

  it("still prefers explicit user cancellation over timeout handling", async () => {
    const fetchMock = vi.fn((_, init?: RequestInit) => {
      return Promise.resolve(createStreamingResponse(init?.signal as AbortSignal, []));
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenRouterAdapter();
    const abortController = new AbortController();
    const responsePromise = adapter.createChatStream(
      createRequest({
        signal: abortController.signal,
      }),
    );
    const failure = expect(responsePromise).rejects.toThrow("Run cancelled.");

    abortController.abort(new Error("Run cancelled."));
    await vi.advanceTimersByTimeAsync(1);
    await failure;
  });
});
