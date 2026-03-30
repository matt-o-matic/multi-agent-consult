import { describe, expect, it } from "vitest";

import { executeTool } from "@/lib/services/tool-broker";

describe("tool-broker question proposal normalization", () => {
  it("accepts alternate prompt field names for proposed user questions", async () => {
    const result = await executeTool(
      "propose_user_questions",
      {
        questions: [
          {
            prompt: "Which tone should the writer favor?",
            options: ["Direct", "Dry", "Warmer"],
          },
        ],
      },
      {
        runId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        role: "participant_b",
        modelId: "test-model",
        searchBackend: "off",
        workspaceManifest: null,
      },
    );

    expect(result.questionProposals).toHaveLength(1);
    expect(result.questionProposals?.[0]?.question).toBe(
      "Which tone should the writer favor?",
    );
    expect(result.questionProposals?.[0]?.options[0]).toMatchObject({
      label: "Direct",
      description: "Direct",
    });
  });
});
