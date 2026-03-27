import { beforeEach, describe, expect, it } from "vitest";

import {
  answerQuestionBatch,
  createRun,
  getRunDetail,
} from "@/lib/data/run-store";
import type {
  ProviderAdapter,
  ProviderChatRequest,
  ProviderChatResponse,
} from "@/lib/providers/base";
import { DebateCoordinator } from "@/lib/services/debate/coordinator";
import { runEventBus } from "@/lib/services/event-bus";
import { clearDatabase } from "@/tests/helpers/database";
import type { NormalizedModel, RunConfig, RunEvent } from "@/lib/types";

type MockResponse = ProviderChatResponse & {
  deltas?: string[];
};

class MockAdapter implements ProviderAdapter {
  readonly key = "openrouter" as const;

  constructor(private readonly responses: MockResponse[]) {}

  async listModels() {
    return [] as NormalizedModel[];
  }

  validateRoleCapabilities() {
    return [];
  }

  async createChatStream(request: ProviderChatRequest) {
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No mock response remaining.");
    }

    let content = "";
    for (const delta of response.deltas ?? []) {
      content += delta;
      request.onTextDelta?.({
        delta,
        content,
      });
    }

    return response;
  }

  async supportsProviderNativeSearch() {
    return false;
  }

  normalizeSources() {
    return [];
  }
}

const config: RunConfig = {
  taskPrompt: "Draft the best answer.",
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
};

function singleTaskPlanResponse() {
  return {
    content: JSON.stringify({
      tasks: [
        {
          title: "Produce the best answer",
          objective: "Create a final-ready answer to the user's request.",
          completionCriteria:
            "One participant draft is ready to ship without another writing pass.",
        },
      ],
    }),
    toolCalls: [],
    usage: null,
    sources: [],
  } satisfies MockResponse;
}

describe("DebateCoordinator", () => {
  beforeEach(() => {
    clearDatabase();
  });

  it("completes a single-task run by selecting the preferred participant draft", async () => {
    const runId = crypto.randomUUID();
    await createRun(runId, config);

    const adapter = new MockAdapter([
      singleTaskPlanResponse(),
      { content: "Participant A draft", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B draft", toolCalls: [], usage: null, sources: [] },
      { content: "Participant A critique of B", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B critique of A", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.91,
          summary: "Participant A is ready to ship.",
          preferredDraft: "participant_a",
          requiredNextFocus: "None",
          remainingDisagreements: "None",
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
    ]);

    await new DebateCoordinator(adapter).executeRun({
      runId,
      config,
      signal: new AbortController().signal,
      waitForAnswers: async () => {
        throw new Error("waitForAnswers should not be called");
      },
    });

    const run = await getRunDetail(runId);
    expect(run?.status).toBe("completed");
    expect(run?.stopReason).toBe("converged");
    expect(run?.taskPlan).toHaveLength(1);
    expect(run?.turns[0]?.phase).toBe("planning");
    expect(run?.finalConsensus?.solution).toBe("Participant A draft");
    expect(run?.turns.some((turn) => turn.phase === "final" && turn.role === "participant_a")).toBe(
      true,
    );
    expect(run?.turns.some((turn) => turn.phase === "final" && turn.role === "referee")).toBe(
      false,
    );
  });

  it("advances through multiple inferred tasks before finalizing", async () => {
    const runId = crypto.randomUUID();
    await createRun(runId, {
      ...config,
      taskPrompt: "Round 1 critique, round 2 rewrite, round 3 converge.",
      maxTurns: 4,
    });

    const adapter = new MockAdapter([
      {
        content: JSON.stringify({
          tasks: [
            {
              title: "Critique the draft",
              objective: "Identify concrete weaknesses and required changes.",
              completionCriteria:
                "Both participants have delivered critique-only feedback and the referee can summarize the direction.",
            },
            {
              title: "Rewrite the draft",
              objective: "Produce updated rewritten drafts that apply the critique.",
              completionCriteria:
                "At least one rewritten participant draft is final-ready and can be selected as the ship candidate.",
            },
          ],
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
      { content: "A critique", toolCalls: [], usage: null, sources: [] },
      { content: "B critique", toolCalls: [], usage: null, sources: [] },
      { content: "A feedback on B critique", toolCalls: [], usage: null, sources: [] },
      { content: "B feedback on A critique", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.83,
          summary: "The critique task is complete.",
          preferredDraft: "participant_a",
          requiredNextFocus: "Move to the rewrite task and apply the critique.",
          remainingDisagreements: "None for the critique task.",
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
      { content: "A rewrite", toolCalls: [], usage: null, sources: [] },
      { content: "B rewrite", toolCalls: [], usage: null, sources: [] },
      { content: "A critique of B rewrite", toolCalls: [], usage: null, sources: [] },
      { content: "B critique of A rewrite", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.9,
          summary: "Participant B produced the stronger final-ready rewrite.",
          preferredDraft: "participant_b",
          requiredNextFocus: "None",
          remainingDisagreements: "None",
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
    ]);

    await new DebateCoordinator(adapter).executeRun({
      runId,
      config: {
        ...config,
        taskPrompt: "Round 1 critique, round 2 rewrite, round 3 converge.",
        maxTurns: 4,
      },
      signal: new AbortController().signal,
      waitForAnswers: async () => {
        throw new Error("waitForAnswers should not be called");
      },
    });

    const run = await getRunDetail(runId);
    expect(run?.status).toBe("completed");
    expect(run?.taskPlan).toHaveLength(2);
    expect(run?.turns[0]?.phase).toBe("planning");
    expect(run?.currentTaskIndex).toBe(1);
    expect(run?.finalConsensus?.solution).toBe("B rewrite");
    expect(run?.refereeDecisions).toHaveLength(2);
    expect(
      run?.turns.filter((turn) => turn.role === "participant_a" && turn.phase === "critique")
        .length,
    ).toBe(2);
    expect(
      run?.turns.filter((turn) => turn.role === "participant_b" && turn.phase === "critique")
        .length,
    ).toBe(2);
    expect(run?.turns.some((turn) => turn.phase === "planning")).toBe(true);
  });

  it("repeats the same milestone in revision mode when the referee says it has not converged", async () => {
    const runId = crypto.randomUUID();
    await createRun(runId, {
      ...config,
      maxTurns: 2,
    });

    const adapter = new MockAdapter([
      singleTaskPlanResponse(),
      { content: "A draft round 1", toolCalls: [], usage: null, sources: [] },
      { content: "B draft round 1", toolCalls: [], usage: null, sources: [] },
      { content: "A critique round 1", toolCalls: [], usage: null, sources: [] },
      { content: "B critique round 1", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: false,
          confidence: 0.42,
          summary: "The milestone is not done yet.",
          preferredDraft: "tie",
          requiredNextFocus: "Revise both drafts around the missing specificity.",
          remainingDisagreements: "Specificity and tone remain unresolved.",
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
      { content: "A revision round 2", toolCalls: [], usage: null, sources: [] },
      { content: "B revision round 2", toolCalls: [], usage: null, sources: [] },
      { content: "A critique round 2", toolCalls: [], usage: null, sources: [] },
      { content: "B critique round 2", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.88,
          summary: "Participant B is now ready to ship.",
          preferredDraft: "participant_b",
          requiredNextFocus: "None",
          remainingDisagreements: "None",
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
    ]);

    await new DebateCoordinator(adapter).executeRun({
      runId,
      config: {
        ...config,
        maxTurns: 2,
      },
      signal: new AbortController().signal,
      waitForAnswers: async () => {
        throw new Error("waitForAnswers should not be called");
      },
    });

    const run = await getRunDetail(runId);
    expect(run?.status).toBe("completed");
    expect(run?.currentTaskIndex).toBe(0);
    expect(run?.refereeDecisions).toHaveLength(2);
    expect(
      run?.turns
        .filter((turn) => turn.role === "participant_a")
        .map((turn) => turn.phase),
    ).toEqual(["proposal", "critique", "revision", "critique"]);
    expect(
      run?.turns
        .filter((turn) => turn.role === "participant_b")
        .map((turn) => turn.phase),
    ).toEqual(["proposal", "critique", "revision", "critique", "final"]);
    expect(run?.finalConsensus?.solution).toBe("B revision round 2");
  });

  it("pauses for a referee question batch and resumes after answers", async () => {
    const runId = crypto.randomUUID();
    await createRun(runId, config);

    const adapter = new MockAdapter([
      singleTaskPlanResponse(),
      { content: "A initial", toolCalls: [], usage: null, sources: [] },
      { content: "B initial", toolCalls: [], usage: null, sources: [] },
      { content: "A critique of initial B", toolCalls: [], usage: null, sources: [] },
      { content: "B critique of initial A", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: false,
          confidence: 0.42,
          summary: "Need a user preference.",
          preferredDraft: "tie",
          requiredNextFocus: "Ask the user about the deployment target.",
          remainingDisagreements: "Deployment target is unknown.",
          needsUserInput: true,
          questionBatch: {
            questions: [
              {
                question: "Where should the app run?",
                options: [
                  {
                    id: "local",
                    label: "Local",
                    description: "Run it on the local machine.",
                    recommended: true,
                  },
                  {
                    id: "cloud",
                    label: "Cloud",
                    description: "Host it remotely.",
                  },
                ],
              },
            ],
          },
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
      { content: "A revised", toolCalls: [], usage: null, sources: [] },
      { content: "B revised", toolCalls: [], usage: null, sources: [] },
      { content: "A critique of revised B", toolCalls: [], usage: null, sources: [] },
      { content: "B critique of revised A", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.88,
          summary: "The drafts now align.",
          preferredDraft: "participant_b",
          requiredNextFocus: "None",
          remainingDisagreements: "None",
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
    ]);

    await new DebateCoordinator(adapter).executeRun({
      runId,
      config,
      signal: new AbortController().signal,
      waitForAnswers: async (batch) => {
        const persisted = await answerQuestionBatch(runId, batch.id, [
          {
            questionId: batch.questions[0]!.id,
            selectedOptionId: "local",
            note: "Keep it local-first.",
          },
        ]);

        if (!persisted) {
          throw new Error("Question batch was not persisted.");
        }

        return persisted;
      },
    });

    const run = await getRunDetail(runId);
    expect(run?.questionBatches[0]?.status).toBe("answered");
    expect(run?.stopReason).toBe("converged");
    expect(run?.finalConsensus?.solution).toBe("B revised");
  });

  it("publishes live turn deltas while a participant response streams", async () => {
    const runId = crypto.randomUUID();
    await createRun(runId, config);

    const events: RunEvent[] = [];
    const unsubscribe = runEventBus.subscribe(runId, (event) => {
      events.push(event);
    });

    const adapter = new MockAdapter([
      singleTaskPlanResponse(),
      {
        content: "Participant A draft",
        deltas: ["Participant ", "A draft"],
        toolCalls: [],
        usage: null,
        sources: [],
      },
      { content: "Participant B draft", toolCalls: [], usage: null, sources: [] },
      { content: "Participant A critique of B", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B critique of A", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.91,
          summary: "The drafts already agree.",
          preferredDraft: "participant_a",
          requiredNextFocus: "None",
          remainingDisagreements: "None",
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
    ]);

    await new DebateCoordinator(adapter).executeRun({
      runId,
      config,
      signal: new AbortController().signal,
      waitForAnswers: async () => {
        throw new Error("waitForAnswers should not be called");
      },
    });

    unsubscribe();

    const deltaEvents = events.filter(
      (event): event is Extract<RunEvent, { type: "turn_delta" }> =>
        event.type === "turn_delta" && event.role === "participant_a",
    );

    expect(deltaEvents.length).toBeGreaterThan(0);
    expect(deltaEvents.at(-1)?.content).toBe("Participant A draft");
  });

  it("selects from the latest completed cycle when max turns are exhausted", async () => {
    const runId = crypto.randomUUID();
    await createRun(runId, {
      ...config,
      maxTurns: 1,
    });

    const adapter = new MockAdapter([
      singleTaskPlanResponse(),
      { content: "Participant A draft", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B draft", toolCalls: [], usage: null, sources: [] },
      { content: "Participant A critique of B", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B critique of A", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: false,
          confidence: 0.66,
          summary: "Participant B is stronger, but the milestone did not fully converge.",
          preferredDraft: "participant_b",
          requiredNextFocus: "A second cycle would tighten the structure.",
          remainingDisagreements: "Some structural issues remain.",
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
    ]);

    await new DebateCoordinator(adapter).executeRun({
      runId,
      config: {
        ...config,
        maxTurns: 1,
      },
      signal: new AbortController().signal,
      waitForAnswers: async () => {
        throw new Error("waitForAnswers should not be called");
      },
    });

    const run = await getRunDetail(runId);
    expect(run?.status).toBe("completed");
    expect(run?.stopReason).toBe("max_turns");
    expect(run?.finalConsensus?.solution).toBe("Participant B draft");
    expect(run?.turns.some((turn) => turn.phase === "final" && turn.role === "referee")).toBe(
      false,
    );
  });

  it("retries a failed turn loop from the existing run state", async () => {
    const runId = crypto.randomUUID();
    await createRun(runId, config);

    const failingAdapter = new MockAdapter([
      singleTaskPlanResponse(),
      { content: "Participant A draft", toolCalls: [], usage: null, sources: [] },
    ]);

    await expect(
      new DebateCoordinator(failingAdapter).executeRun({
        runId,
        config,
        signal: new AbortController().signal,
        waitForAnswers: async () => {
          throw new Error("waitForAnswers should not be called");
        },
      }),
    ).rejects.toThrow("No mock response remaining.");

    const failedRun = await getRunDetail(runId);
    expect(failedRun?.status).toBe("failed");

    const retryAdapter = new MockAdapter([
      { content: "Participant A draft retried", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B draft retried", toolCalls: [], usage: null, sources: [] },
      { content: "Participant A critique retried", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B critique retried", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.93,
          summary: "The retried draft is ready.",
          preferredDraft: "participant_a",
          requiredNextFocus: "None",
          remainingDisagreements: "None",
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
    ]);

    await new DebateCoordinator(retryAdapter).resumeRun({
      runId,
      run: failedRun!,
      carryForwardDecision: false,
      mode: "turn_loop",
      config,
      signal: new AbortController().signal,
      waitForAnswers: async () => {
        throw new Error("waitForAnswers should not be called");
      },
    });

    const retriedRun = await getRunDetail(runId);
    expect(retriedRun?.status).toBe("completed");
    expect(retriedRun?.finalConsensus?.solution).toBe("Participant A draft retried");
    expect(
      retriedRun?.turns.filter((turn) => turn.role === "participant_a" && turn.phase !== "final")
        .length,
    ).toBe(3);
    expect(retriedRun?.turns.some((turn) => turn.phase === "final")).toBe(true);
  });

  it("rejects retrying a failed legacy run with no persisted planning step", async () => {
    const runId = crypto.randomUUID();
    await createRun(runId, config);

    const run = await getRunDetail(runId);
    await expect(
      new DebateCoordinator(new MockAdapter([])).resumeRun({
        runId,
        run: {
          ...run!,
          status: "failed",
        },
        mode: "turn_loop",
        config,
        signal: new AbortController().signal,
        waitForAnswers: async () => {
          throw new Error("waitForAnswers should not be called");
        },
      }),
    ).rejects.toThrow("persisted milestone-planning step");
  });
});
