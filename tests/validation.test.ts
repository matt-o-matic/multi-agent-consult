import { describe, expect, it } from "vitest";

import { questionBatchAnswerSchema, runConfigSchema } from "@/lib/validation";

describe("runConfigSchema", () => {
  it("defaults debateMode to collaborative_debate when omitted at normalization time", () => {
    const parsed = runConfigSchema.parse({
      taskPrompt: "Draft the answer.",
      maxTurns: 3,
      searchBackend: "off",
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
    });

    expect(parsed.debateMode).toBeUndefined();
  });

  it("accepts null workspacePath when workspace mode is off", () => {
    const parsed = runConfigSchema.parse({
      taskPrompt: "Draft the answer.",
      maxTurns: 3,
      debateMode: "writers_room",
      searchBackend: "off",
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
    });

    expect(parsed.workspacePath).toBeNull();
    expect(parsed.debateMode).toBe("writers_room");
  });

  it("accepts arbitrarily large clarification answer batches", () => {
    const parsed = questionBatchAnswerSchema.parse({
      answers: Array.from({ length: 5 }, (_, index) => ({
        questionId: `question-${index + 1}`,
        selectedOptionId: `option-${index + 1}`,
        note: index === 4 ? "Extra context for the last answer." : null,
      })),
    });

    expect(parsed.answers).toHaveLength(5);
  });
});
