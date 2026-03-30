import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderChatError } from "@/lib/providers/base";

const adapterMock = {
  createChatStream: vi.fn(),
};

vi.mock("@/lib/providers/openrouter", () => ({
  getOpenRouterAdapter: () => adapterMock,
}));

import { openRouterNativeSearch } from "@/lib/services/web-tools";

describe("openRouterNativeSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    adapterMock.createChatStream.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries retryable provider failures before giving up", async () => {
    adapterMock.createChatStream
      .mockRejectedValueOnce(
        new ProviderChatError({
          kind: "provider_unavailable",
          message: "Temporary upstream issue.",
          retryable: true,
        }),
      )
      .mockResolvedValueOnce({
        content: "Current reporting summary",
        rawAnnotations: null,
        sources: [],
        toolCalls: [],
        usage: null,
      });

    const searchPromise = openRouterNativeSearch(
      "current AI agent layoffs",
      "openai/gpt-5.4-mini",
    );

    await vi.runAllTimersAsync();
    const result = await searchPromise;

    expect(adapterMock.createChatStream).toHaveBeenCalledTimes(2);
    expect(result.summary).toBe("Current reporting summary");
  });
});
