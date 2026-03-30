import { describe, expect, it } from "vitest";

import { runLiveStateStore } from "@/lib/services/live-state";

describe("RunLiveStateStore", () => {
  it("tracks retry metadata for active turns", () => {
    const runId = crypto.randomUUID();

    runLiveStateStore.applyEvent({
      type: "turn_started",
      runId,
      attempt: 1,
      maxAttempts: 3,
      role: "participant_a",
      phase: "proposal",
      turnIndex: 0,
      modelId: "alpha",
      at: "2026-03-30T15:00:00.000Z",
    });

    runLiveStateStore.applyEvent({
      type: "turn_retrying",
      runId,
      attempt: 2,
      maxAttempts: 3,
      lastError: "OpenRouter completion timed out after 30 seconds without streamed activity.",
      modelId: "alpha",
      phase: "proposal",
      retryDelayMs: 2000,
      role: "participant_a",
      turnIndex: 0,
      at: "2026-03-30T15:00:02.000Z",
    });

    const snapshot = runLiveStateStore.getSnapshot(runId);
    expect(snapshot?.activeTurns).toHaveLength(1);
    expect(snapshot?.activeTurns[0]).toMatchObject({
      attempt: 2,
      lastError: "OpenRouter completion timed out after 30 seconds without streamed activity.",
      maxAttempts: 3,
      retryDelayMs: 2000,
      role: "participant_a",
    });
  });
});
