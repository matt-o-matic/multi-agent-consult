import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { RunSession } from "@/components/run-session";
import type { RunDetail } from "@/lib/types";

vi.mock("next/link", () => ({
  default: function MockLink({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  }) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  },
}));

const now = new Date().toISOString();

const baseRun: RunDetail = {
  activeQuestionBatchId: null,
  createdAt: now,
  debateMode: "collaborative_debate",
  currentTaskIndex: 1,
  currentMilestoneTurn: 1,
  currentTurn: 1,
  errorText: null,
  finalConsensus: null,
  id: "run-1",
  participantA: {
    label: "Participant A",
    modelId: "alpha",
    provider: "openrouter",
    role: "participant_a",
  },
  participantB: {
    label: "Participant B",
    modelId: "beta",
    provider: "openrouter",
    role: "participant_b",
  },
  questionBatches: [],
  referee: {
    label: "Referee",
    modelId: "gamma",
    provider: "openrouter",
    role: "referee",
  },
  refereeDecisions: [
    {
      confidence: 0.82,
      converged: true,
      createdAt: now,
      id: "decision-1",
      needsUserInput: false,
      preferredDraft: "participant_a",
      blockingIssues: [],
      carryForwardNotes: ["Save current-events research for the rewrite milestone."],
      diminishingReturns: ["Do not spend another cycle on micro style polish."],
      questionBatch: null,
      remainingDisagreements: "None for the critique milestone.",
      requiredNextFocus: "Move to the rewrite milestone.",
      runId: "run-1",
      summary: "The critique milestone is complete.",
      turnIndex: 0,
    },
  ],
  searchBackend: "off",
  sources: [],
  status: "running",
  stopReason: null,
  taskPlan: [
    {
      completionCriteria: "Both models have identified the important weaknesses.",
      id: "task-1",
      objective: "Generate critique-only feedback.",
      title: "Critique the draft",
    },
    {
      completionCriteria: "One rewritten draft is ready to ship.",
      id: "task-2",
      objective: "Rewrite the draft using the critique.",
      title: "Rewrite the draft",
    },
    {
      completionCriteria: "The final copy is stable and cohesive.",
      id: "task-3",
      objective: "Converge on the final polish.",
      title: "Final convergence",
    },
  ],
  taskPrompt: "Critique, rewrite, and converge on the final draft.",
  toolInvocations: [],
  turns: [
    {
      content: "{\"tasks\":[{\"title\":\"Critique the draft\"}]}",
      createdAt: now,
      id: "planning",
      modelId: "gamma",
      phase: "planning",
      role: "referee",
      runId: "run-1",
      turnIndex: -1,
    },
    {
      content: "Critique A",
      createdAt: now,
      id: "a-0",
      modelId: "alpha",
      phase: "proposal",
      role: "participant_a",
      runId: "run-1",
      turnIndex: 0,
    },
    {
      content: "Critique of B",
      createdAt: now,
      id: "a-1",
      modelId: "alpha",
      phase: "critique",
      role: "participant_a",
      runId: "run-1",
      turnIndex: 0,
    },
    {
      content: "Rewrite B",
      createdAt: now,
      id: "b-0",
      modelId: "beta",
      phase: "proposal",
      role: "participant_b",
      runId: "run-1",
      turnIndex: 0,
    },
    {
      content: "Critique of A",
      createdAt: now,
      id: "b-1",
      modelId: "beta",
      phase: "critique",
      role: "participant_b",
      runId: "run-1",
      turnIndex: 0,
    },
    {
      content: "{\"converged\":true}",
      createdAt: now,
      id: "r-0",
      modelId: "gamma",
      phase: "referee",
      role: "referee",
      runId: "run-1",
      turnIndex: 0,
    },
  ],
  updatedAt: now,
  workspacePath: null,
  maxTurns: 3,
  liveState: {
    activeTurns: [
      {
        attempt: 1,
        content: "",
        lastError: null,
        maxAttempts: 3,
        modelId: "alpha",
        phase: "proposal",
        retryDelayMs: null,
        role: "participant_a",
        startedAt: now,
        turnIndex: 1,
        updatedAt: now,
      },
    ],
    latestStatusMessage: "Participants are drafting milestone 2: Rewrite the draft.",
    updatedAt: now,
  },
};

describe("RunSession", () => {
  it("renders milestone-first status cards and live thinking indicators", () => {
    const html = renderToStaticMarkup(<RunSession initialRun={baseRun} />);

    expect(html).toContain("Milestone checklist");
    expect(html).toContain("Current milestone");
    expect(html).toContain("Rewrite the draft");
    expect(html).toContain("Cycle 2 of 3");
    expect(html).toContain("remaining 1");
    expect(html).toContain("completed outputs");
    expect(html).toContain("Proposal or revision");
    expect(html).toContain("Critiques");
    expect(html).toContain("Planning passes");
    expect(html).toContain("Evaluations");
    expect(html).toContain("Participant A is thinking");
    expect(html).toContain("thinking proposal, attempt 1 of 3");
    expect(html).toContain("Prompt details");
    expect(html).toContain("Turn history");
    expect(html).toContain("Carry Forward");
  });

  it("renders writer and editor labels plus the planning wait state", () => {
    const html = renderToStaticMarkup(
      <RunSession
        initialRun={{
          ...baseRun,
          debateMode: "writers_room",
          status: "waiting_for_user",
          currentTaskIndex: 0,
          taskPlan: [],
          activeQuestionBatchId: "batch-1",
          participantA: {
            ...baseRun.participantA,
            label: "Writer",
          },
          participantB: {
            ...baseRun.participantB,
            label: "Editor",
          },
          questionBatches: [
            {
              id: "batch-1",
              runId: "run-1",
              status: "pending",
              questions: [
                {
                  id: "question-1",
                  question: "Who is the audience?",
                  options: [
                    {
                      id: "founders",
                      label: "Founders",
                      description: "Target technical founders.",
                      recommended: true,
                    },
                    {
                      id: "marketers",
                      label: "Marketers",
                      description: "Target product and growth teams.",
                    },
                  ],
                },
              ],
              createdAt: now,
              answeredAt: null,
            },
          ],
          liveState: {
            activeTurns: [
              {
                content: "",
                modelId: "gamma",
                phase: "planning",
                role: "referee",
                startedAt: now,
                turnIndex: -1,
                updatedAt: now,
              },
            ],
            latestStatusMessage: "Referee is planning the milestone list.",
            updatedAt: now,
          },
        }}
      />,
    );

    expect(html).toContain("Writer&#x27;s room");
    expect(html).toContain("Writer");
    expect(html).toContain("Editor");
    expect(html).toContain("Planning is waiting on user input");
    expect(html).toContain("The run is paused until this batch is answered");
  });

  it("renders retrying state and attempt metadata for live lanes", () => {
    const html = renderToStaticMarkup(
      <RunSession
        initialRun={{
          ...baseRun,
          liveState: {
            activeTurns: [
              {
                attempt: 2,
                content: "",
                lastError:
                  "OpenRouter completion timed out after 30 seconds without streamed activity.",
                maxAttempts: 3,
                modelId: "alpha",
                phase: "proposal",
                retryDelayMs: 2000,
                role: "participant_a",
                startedAt: now,
                turnIndex: 1,
                updatedAt: now,
              },
            ],
            latestStatusMessage:
              "Participant A proposal attempt 1 failed and is retrying.",
            updatedAt: now,
          },
        }}
      />,
    );

    expect(html).toContain("retrying proposal, attempt 2 of 3");
    expect(html).toContain("backoff 2s");
    expect(html).toContain("Previous attempt failed");
    expect(html).toContain("Participant A is retrying");
  });
});
