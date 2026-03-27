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
  currentTaskIndex: 1,
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
        content: "",
        modelId: "alpha",
        phase: "proposal",
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
    expect(html).toContain("remaining 1");
    expect(html).toContain("completed outputs");
    expect(html).toContain("Proposal or revision");
    expect(html).toContain("Critiques");
    expect(html).toContain("Planning passes");
    expect(html).toContain("Evaluations");
    expect(html).toContain("Model A is thinking");
    expect(html).toContain("thinking proposal");
    expect(html).toContain("Prompt details");
    expect(html).toContain("Turn history");
  });
});
