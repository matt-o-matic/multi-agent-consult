import { describe, expect, it } from "vitest";

import { runConfigSchema } from "@/lib/validation";

describe("runConfigSchema", () => {
  it("accepts null workspacePath when workspace mode is off", () => {
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

    expect(parsed.workspacePath).toBeNull();
  });
});
