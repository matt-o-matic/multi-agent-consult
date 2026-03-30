import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  answerQuestionBatch,
  createRun,
  getRunDetail,
} from "@/lib/data/run-store";
import { ProviderChatError } from "@/lib/providers/base";
import type {
  ProviderAdapter,
  ProviderChatRequest,
  ProviderChatResponse,
} from "@/lib/providers/base";
import { DebateCoordinator } from "@/lib/services/debate/coordinator";
import { runEventBus } from "@/lib/services/event-bus";
import { buildRetryPlan } from "@/lib/services/runs-manager";
import { clearDatabase } from "@/tests/helpers/database";
import type { NormalizedModel, RunConfig, RunEvent } from "@/lib/types";

type MockResponse = ProviderChatResponse & {
  deltas?: string[];
};

type MockAdapterStep = MockResponse | Error;

class MockAdapter implements ProviderAdapter {
  readonly key = "openrouter" as const;
  readonly requests: ProviderChatRequest[] = [];

  constructor(private readonly responses: MockAdapterStep[]) {}

  async listModels() {
    return [] as NormalizedModel[];
  }

  validateRoleCapabilities() {
    return [];
  }

  async createChatStream(request: ProviderChatRequest) {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No mock response remaining.");
    }

    if (response instanceof Error) {
      throw response;
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
  debateMode: "collaborative_debate",
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
      outcome: "tasks",
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

function multiTaskPlanResponse(count: number) {
  return {
    content: JSON.stringify({
      outcome: "tasks",
      tasks: Array.from({ length: count }, (_, index) => ({
        title: `Milestone ${index + 1}`,
        objective: `Complete milestone ${index + 1}.`,
        completionCriteria: `Milestone ${index + 1} is good enough to advance.`,
      })),
    }),
    toolCalls: [],
    usage: null,
    sources: [],
  } satisfies MockResponse;
}

function retryableTimeoutError(message = "OpenRouter completion timed out after 30 seconds without streamed activity.") {
  return new ProviderChatError({
    kind: "timeout_idle",
    message,
    retryable: true,
  });
}

describe("DebateCoordinator", () => {
  beforeEach(() => {
    clearDatabase();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
          outcome: "tasks",
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

    const clarificationQuestions = Array.from({ length: 5 }, (_, index) => ({
      question: `Clarification ${index + 1}?`,
      options: ["Preferred", "Fallback", "Skip"],
    }));

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
            questions: clarificationQuestions,
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

    let receivedQuestionCount = 0;

    await new DebateCoordinator(adapter).executeRun({
      runId,
      config,
      signal: new AbortController().signal,
      waitForAnswers: async (batch) => {
        receivedQuestionCount = batch.questions.length;
        expect(batch.questions).toHaveLength(5);
        expect(batch.questions[0]?.options[0]).toMatchObject({
          label: "Preferred",
          description: "Preferred",
        });

        const persisted = await answerQuestionBatch(
          runId,
          batch.id,
          batch.questions.map((question) => ({
            questionId: question.id,
            selectedOptionId: question.options[0]?.id ?? null,
            note:
              question.id === batch.questions.at(-1)?.id
                ? "Keep it local-first."
                : null,
          })),
        );

        if (!persisted) {
          throw new Error("Question batch was not persisted.");
        }

        return persisted;
      },
    });

    const run = await getRunDetail(runId);
    expect(receivedQuestionCount).toBe(5);
    expect(run?.questionBatches[0]?.status).toBe("answered");
    expect(run?.questionBatches[0]?.questions).toHaveLength(5);
    expect(run?.questionBatches[0]?.questions[0]?.options[0]?.label).toBe("Preferred");
    expect(run?.stopReason).toBe("converged");
    expect(run?.finalConsensus?.solution).toBe("B revised");
  });

  it("normalizes alternate question field names in referee question batches", async () => {
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
          confidence: 0.41,
          summary: "Need a user preference before continuing.",
          preferredDraft: "tie",
          requiredNextFocus: "Resolve the missing tone choice.",
          remainingDisagreements: "Tone and intended audience are still open.",
          needsUserInput: true,
          questionBatch: {
            questions: [
              {
                prompt: "Which audience should this optimize for?",
                options: ["Architects", "Executives", "Mixed audience"],
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
          confidence: 0.9,
          summary: "The drafts now align.",
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
      waitForAnswers: async (batch) => {
        expect(batch.questions).toHaveLength(1);
        expect(batch.questions[0]?.question).toBe(
          "Which audience should this optimize for?",
        );
        expect(batch.questions[0]?.options[0]).toMatchObject({
          label: "Architects",
          description: "Architects",
        });

        const persisted = await answerQuestionBatch(runId, batch.id, [
          {
            questionId: batch.questions[0]!.id,
            selectedOptionId: batch.questions[0]!.options[0]!.id,
            note: "Keep it technical but readable.",
          },
        ]);

        if (!persisted) {
          throw new Error("Question batch was not persisted.");
        }

        return persisted;
      },
    });

    const run = await getRunDetail(runId);
    expect(run?.status).toBe("completed");
    expect(run?.questionBatches[0]?.questions[0]?.question).toBe(
      "Which audience should this optimize for?",
    );
  });

  it("repairs invalid planning JSON inside the same run", async () => {
    const runId = crypto.randomUUID();
    await createRun(runId, config);

    const adapter = new MockAdapter([
      { content: "{\"outcome\":\"tasks\"", toolCalls: [], usage: null, sources: [] },
      singleTaskPlanResponse(),
      { content: "Participant A draft", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B draft", toolCalls: [], usage: null, sources: [] },
      { content: "Participant A critique of B", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B critique of A", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.88,
          summary: "Planning repair succeeded and the run completed.",
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
    expect(
      run?.turns.filter((turn) => turn.role === "referee" && turn.phase === "planning").length,
    ).toBe(1);
    expect(adapter.requests[1]?.messages.at(-1)?.content).toContain(
      "could not be parsed as valid JSON",
    );
  });

  it("repairs invalid referee JSON before failing the whole run", async () => {
    const runId = crypto.randomUUID();
    await createRun(runId, config);

    const adapter = new MockAdapter([
      singleTaskPlanResponse(),
      { content: "Participant A draft", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B draft", toolCalls: [], usage: null, sources: [] },
      { content: "Participant A critique of B", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B critique of A", toolCalls: [], usage: null, sources: [] },
      { content: "{\"converged\":", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.91,
          summary: "The repaired referee decision is valid.",
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
      waitForAnswers: async () => {
        throw new Error("waitForAnswers should not be called");
      },
    });

    const run = await getRunDetail(runId);
    expect(run?.status).toBe("completed");
    expect(run?.finalConsensus?.solution).toBe("Participant B draft");
    expect(adapter.requests.at(-1)?.messages.at(-1)?.content).toContain(
      "could not be parsed as valid JSON",
    );
  });

  it("retries a participant timeout in place instead of failing the run immediately", async () => {
    vi.useFakeTimers();

    const runId = crypto.randomUUID();
    const writerRoomConfig: RunConfig = {
      ...config,
      debateMode: "writers_room",
      participantA: {
        ...config.participantA,
        label: "Writer",
      },
      participantB: {
        ...config.participantB,
        label: "Editor",
      },
    };
    await createRun(runId, writerRoomConfig);

    const adapter = new MockAdapter([
      singleTaskPlanResponse(),
      retryableTimeoutError(),
      { content: "Participant A draft after retry", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B critique of A", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.89,
          summary: "Retry succeeded.",
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

    const runPromise = new DebateCoordinator(adapter).executeRun({
      runId,
      config: writerRoomConfig,
      signal: new AbortController().signal,
      waitForAnswers: async () => {
        throw new Error("waitForAnswers should not be called");
      },
    });

    await vi.runAllTimersAsync();
    await runPromise;

    const run = await getRunDetail(runId);
    expect(run?.status).toBe("completed");
    expect(
      run?.turns.filter(
        (turn) => turn.role === "participant_a" && turn.phase === "proposal",
      ).length,
    ).toBe(1);
    expect(run?.finalConsensus?.solution).toBe("Participant A draft after retry");
  });

  it("fails only after the retry budget is exhausted", async () => {
    vi.useFakeTimers();

    const runId = crypto.randomUUID();
    await createRun(runId, config);

    const adapter = new MockAdapter([
      retryableTimeoutError("First attempt timed out."),
      retryableTimeoutError("Second attempt timed out."),
      retryableTimeoutError("Third attempt timed out."),
    ]);

    const runPromise = new DebateCoordinator(adapter).executeRun({
      runId,
      config,
      signal: new AbortController().signal,
      waitForAnswers: async () => {
        throw new Error("waitForAnswers should not be called");
      },
    });

    const failure = expect(runPromise).rejects.toThrow("failed after 3 attempts");
    await vi.runAllTimersAsync();
    await failure;

    const run = await getRunDetail(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorText).toContain("failed after 3 attempts");
    expect(run?.turns).toHaveLength(0);
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

  it("allows a participant turn to use more than six tool exchanges before answering", async () => {
    const runId = crypto.randomUUID();
    await createRun(runId, config);

    const repeatedToolResponses = Array.from({ length: 7 }, (_, index) => ({
      content: "",
      toolCalls: [
        {
          id: `tool-${index + 1}`,
          name: "propose_user_questions",
          arguments: {
            questions: [
              {
                question: `Clarification ${index + 1}?`,
                options: ["Yes", "No"],
              },
            ],
          },
        },
      ],
      usage: null,
      sources: [],
    } satisfies MockResponse));

    const adapter = new MockAdapter([
      singleTaskPlanResponse(),
      { content: "Participant A draft", toolCalls: [], usage: null, sources: [] },
      ...repeatedToolResponses,
      { content: "Participant B draft after tool research", toolCalls: [], usage: null, sources: [] },
      { content: "Participant A critique of B", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B critique of A", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.9,
          summary: "Participant B completed the research-heavy pass.",
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
      waitForAnswers: async () => {
        throw new Error("waitForAnswers should not be called");
      },
    });

    const run = await getRunDetail(runId);
    expect(run?.status).toBe("completed");
    expect(run?.finalConsensus?.solution).toBe("Participant B draft after tool research");
    expect(
      run?.toolInvocations.filter(
        (tool) =>
          tool.role === "participant_b" && tool.toolName === "propose_user_questions",
      ).length,
    ).toBe(7);
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

  it("treats maxTurns as a per-milestone cap instead of a whole-run cap", async () => {
    const runId = crypto.randomUUID();
    await createRun(runId, {
      ...config,
      taskPrompt: "Round 1 critique, round 2 rewrite.",
      maxTurns: 1,
    });

    const adapter = new MockAdapter([
      {
        content: JSON.stringify({
          outcome: "tasks",
          tasks: [
            {
              title: "Critique",
              objective: "Get concrete critique in place.",
              completionCriteria: "The critique direction is good enough to advance.",
            },
            {
              title: "Rewrite",
              objective: "Produce the rewritten draft.",
              completionCriteria: "One draft is ready to ship.",
            },
          ],
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
      { content: "A critique draft", toolCalls: [], usage: null, sources: [] },
      { content: "B critique draft", toolCalls: [], usage: null, sources: [] },
      { content: "A critique feedback", toolCalls: [], usage: null, sources: [] },
      { content: "B critique feedback", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: false,
          confidence: 0.52,
          summary: "The critique milestone is good enough to advance even though polish remains.",
          preferredDraft: "tie",
          requiredNextFocus: "Move on to the rewrite milestone.",
          remainingDisagreements: "Minor style disagreements remain.",
          carryForwardNotes: ["Keep the style nits as carry-forward polish."],
          blockingIssues: [],
          diminishingReturns: ["Another critique-only cycle would be redundant."],
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
      { content: "A rewrite", toolCalls: [], usage: null, sources: [] },
      { content: "B rewrite", toolCalls: [], usage: null, sources: [] },
      { content: "A critique of rewrite", toolCalls: [], usage: null, sources: [] },
      { content: "B critique of rewrite", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.91,
          summary: "Participant B has the stronger rewrite.",
          preferredDraft: "participant_b",
          requiredNextFocus: "None",
          remainingDisagreements: "None",
          blockingIssues: [],
          carryForwardNotes: [],
          diminishingReturns: [],
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
        taskPrompt: "Round 1 critique, round 2 rewrite.",
        maxTurns: 1,
      },
      signal: new AbortController().signal,
      waitForAnswers: async () => {
        throw new Error("waitForAnswers should not be called");
      },
    });

    const run = await getRunDetail(runId);
    expect(run?.status).toBe("completed");
    expect(run?.taskPlan).toHaveLength(2);
    expect(run?.stopReason).toBe("converged");
    expect(run?.currentTaskIndex).toBe(1);
    expect(run?.currentMilestoneTurn).toBe(0);
    expect(run?.finalConsensus?.solution).toBe("B rewrite");
  });

  it("shares editor research back into the writer revision prompt as structured evidence", async () => {
    const runId = crypto.randomUUID();
    const writerRoomConfig: RunConfig = {
      ...config,
      debateMode: "writers_room",
      maxTurns: 2,
      participantA: {
        ...config.participantA,
        label: "Writer",
      },
      participantB: {
        ...config.participantB,
        label: "Editor",
      },
    };
    await createRun(runId, writerRoomConfig);

    const adapter = new MockAdapter([
      singleTaskPlanResponse(),
      { content: "Writer draft round 1", toolCalls: [], usage: null, sources: [] },
      {
        content: "Editor critique round 1",
        toolCalls: [],
        usage: null,
        sources: [
          {
            id: "source-1",
            url: "https://example.com/news",
            title: "AI rollout article",
            domain: "example.com",
            snippet: "Recent reporting on AI rollout failures.",
            sourceType: "web",
            createdAt: new Date().toISOString(),
          },
        ],
      },
      {
        content: JSON.stringify({
          converged: false,
          confidence: 0.44,
          summary: "The editor found a substantive issue.",
          preferredDraft: "tie",
          requiredNextFocus: "Revise using the cited reporting.",
          remainingDisagreements: "The draft still needs the external grounding.",
          blockingIssues: ["The current-events section needs the cited reporting woven in."],
          carryForwardNotes: [],
          diminishingReturns: [],
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
      { content: "Writer revision round 2", toolCalls: [], usage: null, sources: [] },
      { content: "Editor critique round 2", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.9,
          summary: "The writer applied the evidence and is ready.",
          preferredDraft: "participant_a",
          requiredNextFocus: "None",
          remainingDisagreements: "None",
          blockingIssues: [],
          carryForwardNotes: [],
          diminishingReturns: [],
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
    ]);

    await new DebateCoordinator(adapter).executeRun({
      runId,
      config: writerRoomConfig,
      signal: new AbortController().signal,
      waitForAnswers: async () => {
        throw new Error("waitForAnswers should not be called");
      },
    });

    const writerRevisionRequest = adapter.requests.find(
      (request) =>
        request.modelId === writerRoomConfig.participantA.modelId &&
        request.messages.some(
          (message) =>
            message.role === "user" &&
            message.content.includes("Current milestone cycle: 2 of 2"),
        ),
    );

    expect(writerRevisionRequest).toBeTruthy();
    expect(writerRevisionRequest?.messages.at(-1)?.content).toContain("AI rollout article");
    expect(writerRevisionRequest?.messages.at(-1)?.content).toContain(
      "Recent reporting on AI rollout failures.",
    );
  });

  it("can pause for clarification before the milestone plan exists", async () => {
    const runId = crypto.randomUUID();
    await createRun(runId, config);

    const planningQuestions = Array.from({ length: 5 }, (_, index) => ({
      question: `Planning clarification ${index + 1}?`,
      options: ["Short", "Detailed", "Need both"],
    }));

    const adapter = new MockAdapter([
      {
        content: JSON.stringify({
          outcome: "question_batch",
          summary: "Need one clarification before planning milestones.",
          questionBatch: {
            questions: planningQuestions,
          },
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
      singleTaskPlanResponse(),
      { content: "Participant A draft", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B draft", toolCalls: [], usage: null, sources: [] },
      { content: "Participant A critique", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B critique", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.87,
          summary: "The milestone is complete.",
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
      waitForAnswers: async (batch) => {
        expect(batch.questions).toHaveLength(5);
        expect(batch.questions[0]?.options[0]).toMatchObject({
          label: "Short",
          description: "Short",
        });

        const persisted = await answerQuestionBatch(
          runId,
          batch.id,
          batch.questions.map((question) => ({
            questionId: question.id,
            selectedOptionId: question.options[0]?.id ?? null,
            note: question.id === batch.questions[0]?.id ? "Stay concise." : null,
          })),
        );

        if (!persisted) {
          throw new Error("Question batch was not persisted.");
        }

        return persisted;
      },
    });

    const run = await getRunDetail(runId);
    expect(run?.questionBatches[0]?.status).toBe("answered");
    expect(run?.questionBatches[0]?.questions).toHaveLength(5);
    expect(run?.questionBatches[0]?.questions[0]?.options[0]?.label).toBe("Short");
    expect(run?.taskPlan).toHaveLength(1);
    expect(
      run?.turns.filter((turn) => turn.role === "referee" && turn.phase === "planning").length,
    ).toBe(2);
    expect(run?.turns.find((turn) => turn.role === "participant_a")?.turnIndex).toBe(0);
  });

  it("runs writer's room mode as writer draft, editor critique, then referee evaluation", async () => {
    const runId = crypto.randomUUID();
    const writerRoomConfig: RunConfig = {
      ...config,
      debateMode: "writers_room",
      participantA: {
        ...config.participantA,
        label: "Writer",
      },
      participantB: {
        ...config.participantB,
        label: "Editor",
      },
    };
    await createRun(runId, writerRoomConfig);

    const adapter = new MockAdapter([
      singleTaskPlanResponse(),
      { content: "Writer draft", toolCalls: [], usage: null, sources: [] },
      { content: "Editor critique", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.92,
          summary: "The writer draft is ready.",
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
      config: writerRoomConfig,
      signal: new AbortController().signal,
      waitForAnswers: async () => {
        throw new Error("waitForAnswers should not be called");
      },
    });

    const run = await getRunDetail(runId);
    expect(run?.status).toBe("completed");
    expect(
      run?.turns.filter((turn) => turn.role === "participant_a").map((turn) => turn.phase),
    ).toEqual(["proposal", "final"]);
    expect(
      run?.turns.filter((turn) => turn.role === "participant_b").map((turn) => turn.phase),
    ).toEqual(["critique"]);
    expect(run?.finalConsensus?.solution).toBe("Writer draft");
  });

  it("repeats the same milestone in writer's room mode when the editor finds substantive issues", async () => {
    const runId = crypto.randomUUID();
    const writerRoomConfig: RunConfig = {
      ...config,
      debateMode: "writers_room",
      maxTurns: 2,
      participantA: {
        ...config.participantA,
        label: "Writer",
      },
      participantB: {
        ...config.participantB,
        label: "Editor",
      },
    };
    await createRun(runId, writerRoomConfig);

    const adapter = new MockAdapter([
      singleTaskPlanResponse(),
      { content: "Writer draft round 1", toolCalls: [], usage: null, sources: [] },
      { content: "Editor critique round 1", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: false,
          confidence: 0.41,
          summary: "The critique is substantive and the writer should revise.",
          preferredDraft: "tie",
          requiredNextFocus: "Revise the structure and answer the missing question.",
          remainingDisagreements: "The current draft is still underspecified.",
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
      { content: "Writer revision round 2", toolCalls: [], usage: null, sources: [] },
      { content: "Editor critique round 2", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.9,
          summary: "The revised writer draft is ready.",
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
      config: writerRoomConfig,
      signal: new AbortController().signal,
      waitForAnswers: async () => {
        throw new Error("waitForAnswers should not be called");
      },
    });

    const run = await getRunDetail(runId);
    expect(run?.status).toBe("completed");
    expect(
      run?.turns.filter((turn) => turn.role === "participant_a").map((turn) => turn.phase),
    ).toEqual(["proposal", "revision", "final"]);
    expect(
      run?.turns.filter((turn) => turn.role === "participant_b").map((turn) => turn.phase),
    ).toEqual(["critique", "critique"]);
    expect(run?.finalConsensus?.solution).toBe("Writer revision round 2");
  });

  it("does not emit a final artifact before a five-milestone writer's-room run advances past milestone 1", async () => {
    const runId = crypto.randomUUID();
    const writerRoomConfig: RunConfig = {
      ...config,
      debateMode: "writers_room",
      maxTurns: 2,
      participantA: {
        ...config.participantA,
        label: "Writer",
      },
      participantB: {
        ...config.participantB,
        label: "Editor",
      },
    };
    await createRun(runId, writerRoomConfig);

    const adapter = new MockAdapter([
      multiTaskPlanResponse(5),
      { content: "Writer draft milestone 1 cycle 1", toolCalls: [], usage: null, sources: [] },
      { content: "Editor critique milestone 1 cycle 1", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: false,
          confidence: 0.52,
          summary: "Milestone 1 still needs another writing pass.",
          preferredDraft: "tie",
          requiredNextFocus: "Tighten the throughline and bridge into the macro section.",
          remainingDisagreements: "The opening still reads as two linked essays.",
          blockingIssues: ["The current milestone still needs a clearer causal bridge."],
          carryForwardNotes: ["Keep the existing section order."],
          diminishingReturns: [],
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
      { content: "Writer revision milestone 1 cycle 2", toolCalls: [], usage: null, sources: [] },
      { content: "Editor critique milestone 1 cycle 2", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.88,
          summary: "Milestone 1 is now good enough to advance.",
          preferredDraft: "participant_a",
          requiredNextFocus: "Move to milestone 2 and add current-events framing.",
          remainingDisagreements: "None blocking for milestone 1.",
          blockingIssues: [],
          carryForwardNotes: ["Preserve the stronger opening cadence."],
          diminishingReturns: ["Do not spend another cycle on milestone 1 polish."],
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
      { content: "Writer draft milestone 2 cycle 1", toolCalls: [], usage: null, sources: [] },
      { content: "Editor critique milestone 2 cycle 1", toolCalls: [], usage: null, sources: [] },
    ]);

    await expect(
      new DebateCoordinator(adapter).executeRun({
        runId,
        config: writerRoomConfig,
        signal: new AbortController().signal,
        waitForAnswers: async () => {
          throw new Error("waitForAnswers should not be called");
        },
      }),
    ).rejects.toThrow("No mock response remaining.");

    const run = await getRunDetail(runId);
    expect(run?.status).toBe("failed");
    expect(run?.taskPlan).toHaveLength(5);
    expect(run?.finalConsensus).toBeNull();
    expect(run?.turns.some((turn) => turn.phase === "final")).toBe(false);
    expect(
      run?.turns.some(
        (turn) =>
          turn.turnIndex === 2 &&
          turn.role === "participant_a" &&
          turn.phase === "proposal",
      ),
    ).toBe(true);
    expect(run?.currentTaskIndex).toBe(1);
  });

  it("plans retry of a non-final failed writer's-room milestone as a turn-loop retry", async () => {
    const runId = crypto.randomUUID();
    const writerRoomConfig: RunConfig = {
      ...config,
      debateMode: "writers_room",
      maxTurns: 2,
      participantA: {
        ...config.participantA,
        label: "Writer",
      },
      participantB: {
        ...config.participantB,
        label: "Editor",
      },
    };
    await createRun(runId, writerRoomConfig);

    const adapter = new MockAdapter([
      multiTaskPlanResponse(2),
      { content: "Writer draft milestone 1 cycle 1", toolCalls: [], usage: null, sources: [] },
      { content: "Editor critique milestone 1 cycle 1", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: false,
          confidence: 0.46,
          summary: "Milestone 1 needs another writer pass.",
          preferredDraft: "tie",
          requiredNextFocus: "Revise the current milestone.",
          remainingDisagreements: "The core bridge is still missing.",
          blockingIssues: ["The current milestone is not complete yet."],
          carryForwardNotes: [],
          diminishingReturns: [],
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
    ]);

    await expect(
      new DebateCoordinator(adapter).executeRun({
        runId,
        config: writerRoomConfig,
        signal: new AbortController().signal,
        waitForAnswers: async () => {
          throw new Error("waitForAnswers should not be called");
        },
      }),
    ).rejects.toThrow("No mock response remaining.");

    const failedRun = await getRunDetail(runId);
    expect(failedRun?.status).toBe("failed");

    const retryPlan = buildRetryPlan(failedRun!);
    expect(retryPlan.mode).toBe("turn_loop");
    expect(retryPlan.currentTaskIndex).toBe(0);
    expect(retryPlan.currentMilestoneTurn).toBe(1);
  });

  it("rejects finalization-only resume before the final milestone", async () => {
    const runId = crypto.randomUUID();
    const writerRoomConfig: RunConfig = {
      ...config,
      debateMode: "writers_room",
      maxTurns: 2,
      participantA: {
        ...config.participantA,
        label: "Writer",
      },
      participantB: {
        ...config.participantB,
        label: "Editor",
      },
    };
    await createRun(runId, writerRoomConfig);

    const failingAdapter = new MockAdapter([
      multiTaskPlanResponse(2),
      { content: "Writer draft milestone 1 cycle 1", toolCalls: [], usage: null, sources: [] },
      { content: "Editor critique milestone 1 cycle 1", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: false,
          confidence: 0.44,
          summary: "Milestone 1 still needs work.",
          preferredDraft: "tie",
          requiredNextFocus: "Revise the current milestone.",
          remainingDisagreements: "The current milestone is not complete.",
          blockingIssues: ["The bridge sentence is still missing."],
          carryForwardNotes: [],
          diminishingReturns: [],
          needsUserInput: false,
        }),
        toolCalls: [],
        usage: null,
        sources: [],
      },
    ]);

    await expect(
      new DebateCoordinator(failingAdapter).executeRun({
        runId,
        config: writerRoomConfig,
        signal: new AbortController().signal,
        waitForAnswers: async () => {
          throw new Error("waitForAnswers should not be called");
        },
      }),
    ).rejects.toThrow("No mock response remaining.");

    const failedRun = await getRunDetail(runId);
    expect(failedRun?.status).toBe("failed");

    await expect(
      new DebateCoordinator(new MockAdapter([])).resumeRun({
        runId,
        run: failedRun!,
        carryForwardDecision: true,
        mode: "final_synthesis",
        config: writerRoomConfig,
        signal: new AbortController().signal,
        waitForAnswers: async () => {
          throw new Error("waitForAnswers should not be called");
        },
      }),
    ).rejects.toThrow("Cannot finalize before the final milestone.");

    const retriedRun = await getRunDetail(runId);
    expect(retriedRun?.status).toBe("failed");
    expect(retriedRun?.finalConsensus).toBeNull();
    expect(retriedRun?.turns.some((turn) => turn.phase === "final")).toBe(false);
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

  it("retries a valid failed planning-question run without treating it as legacy", async () => {
    const runId = crypto.randomUUID();
    await createRun(runId, config);

    const failingAdapter = new MockAdapter([
      {
        content: JSON.stringify({
          outcome: "question_batch",
          summary: "Need one clarification before planning milestones.",
          questionBatch: {
            questions: [
              {
                question: "Should the answer optimize for speed or detail?",
                options: [
                  {
                    id: "speed",
                    label: "Speed",
                    description: "Keep it concise and fast.",
                    recommended: true,
                  },
                  {
                    id: "detail",
                    label: "Detail",
                    description: "Allow more explanation.",
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
    ]);

    await expect(
      new DebateCoordinator(failingAdapter).executeRun({
        runId,
        config,
        signal: new AbortController().signal,
        waitForAnswers: async (batch) => {
          const persisted = await answerQuestionBatch(runId, batch.id, [
            {
              questionId: batch.questions[0]!.id,
              selectedOptionId: "speed",
              note: "Keep it tight.",
            },
          ]);

          if (!persisted) {
            throw new Error("Question batch was not persisted.");
          }

          return persisted;
        },
      }),
    ).rejects.toThrow("No mock response remaining.");

    const failedRun = await getRunDetail(runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.taskPlan).toHaveLength(0);
    expect(
      failedRun?.turns.filter((turn) => turn.role === "referee" && turn.phase === "planning")
        .length,
    ).toBe(1);

    const retryAdapter = new MockAdapter([
      singleTaskPlanResponse(),
      { content: "Participant A draft retried", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B draft retried", toolCalls: [], usage: null, sources: [] },
      { content: "Participant A critique retried", toolCalls: [], usage: null, sources: [] },
      { content: "Participant B critique retried", toolCalls: [], usage: null, sources: [] },
      {
        content: JSON.stringify({
          converged: true,
          confidence: 0.9,
          summary: "The retried run is ready.",
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
    expect(retriedRun?.taskPlan).toHaveLength(1);
    expect(retriedRun?.questionBatches[0]?.status).toBe("answered");
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
