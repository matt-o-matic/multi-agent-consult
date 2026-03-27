import { describe, expect, it } from "vitest";

import { OpenRouterAdapter } from "@/lib/providers/openrouter";
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
