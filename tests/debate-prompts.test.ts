import { describe, expect, it } from "vitest";

import {
  buildParticipantSystemPrompt,
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
  it("keeps the collaborative referee in a meta-evaluation role", () => {
    const prompt = buildRefereeSystemPrompt({
      debateMode: "collaborative_debate",
    });

    expect(prompt).toContain("You are not a participant.");
    expect(prompt).toContain("do not rewrite either draft");
    expect(prompt).toContain("do not join the debate");
    expect(prompt).toContain("both participant outputs and both participant critiques");
    expect(prompt).toContain("Ask clarifying questions instead of guessing");
    expect(prompt).toContain("good-enough-to-advance");
    expect(prompt).toContain("carry forward to a later milestone");
  });

  it("makes writer's room constraints explicit for the referee", () => {
    const prompt = buildRefereeSystemPrompt({
      debateMode: "writers_room",
    });

    expect(prompt).toContain("Writer has produced the current draft");
    expect(prompt).toContain("Editor has produced the current critique");
    expect(prompt).toContain("preferredDraft must never be participant_b");
  });

  it("asks the referee to judge the current task instead of the whole run", () => {
    const prompt = buildRefereeUserPrompt({
      debateMode: "collaborative_debate",
      taskPrompt: "Improve this answer in stages.",
      taskPlan,
      currentTaskIndex: 0,
      currentMilestoneTurn: 1,
      maxMilestoneTurns: 3,
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
      carryForwardNotes: ["Keep the current-events research for the rewrite milestone."],
      evidencePackets: [],
      answeredQuestionBatches: [],
      questionProposals: [
        { role: "participant_a", proposals: [] },
        { role: "participant_b", proposals: [] },
      ],
    });

    expect(prompt).toContain("Milestone plan:");
    expect(prompt).toContain("Current milestone under review:");
    expect(prompt).toContain("Convergence applies to the current milestone only");
    expect(prompt).toContain("Participant question proposals:");
    expect(prompt).toContain("Current milestone cycle: 2 of 3");
    expect(prompt).toContain("carryForwardNotes: string[]");
  });

  it("builds a planning prompt that can ask questions before inventing milestones", () => {
    const systemPrompt = buildTaskPlanSystemPrompt("writers_room");
    const userPrompt = buildTaskPlanUserPrompt({
      debateMode: "writers_room",
      taskPrompt: "Rewrite this post in a writer/editor loop.",
      answeredQuestionBatches: [],
    });

    expect(systemPrompt).toContain("outcome\":\"question_batch");
    expect(systemPrompt).toContain("Ask questions instead of inventing milestones");
    expect(systemPrompt).toContain("Honor explicit user-stated stages first");
    expect(systemPrompt).toContain("productive work units over micro-audits");
    expect(userPrompt).toContain("Writer's room");
    expect(userPrompt).toContain("Return either:");
  });

  it("tells participants to ask clarifying questions instead of assuming", () => {
    const prompt = buildParticipantSystemPrompt({
      debateMode: "writers_room",
      role: "participant_b",
    });

    expect(prompt).toContain("You are the Editor.");
    expect(prompt).toContain("Ask clarifying questions instead of guessing");
    expect(prompt).toContain("avoid authoring a competing replacement draft");
  });
});
