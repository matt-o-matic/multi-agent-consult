import { describe, expect, it } from "vitest";

import {
  buildRefereeSystemPrompt,
  buildRefereeUserPrompt,
  buildTaskPlanSystemPrompt,
  buildTaskPlanUserPrompt,
} from "@/lib/services/debate/prompts";

const taskPlan = [
  {
    id: "task-1",
    title: "Critique",
    objective: "Critique the source draft.",
    completionCriteria: "Both critiques are complete.",
  },
  {
    id: "task-2",
    title: "Rewrite",
    objective: "Rewrite the source draft.",
    completionCriteria: "One rewritten draft is final-ready.",
  },
];

describe("debate prompts", () => {
  it("keeps the referee in a meta-evaluation role", () => {
    const prompt = buildRefereeSystemPrompt();

    expect(prompt).toContain("You are not a participant.");
    expect(prompt).toContain("do not rewrite either draft");
    expect(prompt).toContain("do not join the debate");
    expect(prompt).toContain("both participant outputs and both participant critiques");
    expect(prompt).toContain("If another participant writing pass is needed");
    expect(prompt).toContain("preferredDraft must be participant_a or participant_b");
  });

  it("asks the referee to judge the current task instead of the whole run", () => {
    const prompt = buildRefereeUserPrompt({
      taskPrompt: "Improve this answer in stages.",
      taskPlan,
      currentTaskIndex: 0,
      turnIndex: 0,
      participantATurn: {
        id: "a",
        runId: "run",
        turnIndex: 0,
        role: "participant_a",
        phase: "proposal",
        modelId: "alpha",
        content: "Draft A",
        createdAt: new Date().toISOString(),
      },
      participantBTurn: {
        id: "b",
        runId: "run",
        turnIndex: 0,
        role: "participant_b",
        phase: "proposal",
        modelId: "beta",
        content: "Draft B",
        createdAt: new Date().toISOString(),
      },
      answeredQuestionBatches: [],
      questionProposals: [
        { role: "participant_a", proposals: [] },
        { role: "participant_b", proposals: [] },
      ],
    });

    expect(prompt).toContain("Milestone plan:");
    expect(prompt).toContain("Current milestone under review:");
    expect(prompt).toContain("Convergence applies to the current milestone only.");
    expect(prompt).toContain(
      "short operational guidance for the current milestone or the immediate next milestone",
    );
  });

  it("builds a structured task-plan prompt", () => {
    expect(buildTaskPlanSystemPrompt()).toContain("Create 1-5 sequential milestones.");
    expect(buildTaskPlanSystemPrompt()).toContain("Do not judge convergence");
    expect(buildTaskPlanUserPrompt("Critique then rewrite this draft.")).toContain(
      "each milestone must include title, objective, completionCriteria",
    );
  });
});
