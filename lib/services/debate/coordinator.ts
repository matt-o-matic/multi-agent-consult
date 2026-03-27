import "server-only";

import { z } from "zod";

import {
  recordRefereeDecision,
  recordSourceRecords,
  recordToolInvocation,
  recordTurn,
  saveFinalConsensus,
  saveTaskPlan,
  saveQuestionBatch,
  updateRunStatus,
} from "@/lib/data/run-store";
import type { ProviderMessage } from "@/lib/providers/base";
import type { ProviderAdapter } from "@/lib/providers/base";
import {
  buildParticipantSystemPrompt,
  buildParticipantUserPrompt,
  buildParticipantCritiqueUserPrompt,
  buildRefereeSystemPrompt,
  buildRefereeUserPrompt,
  buildTaskPlanSystemPrompt,
  buildTaskPlanUserPrompt,
} from "@/lib/services/debate/prompts";
import { runEventBus } from "@/lib/services/event-bus";
import { runLiveStateStore } from "@/lib/services/live-state";
import {
  executeTool,
  participantToolDefinitions,
} from "@/lib/services/tool-broker";
import type {
  ActorRole,
  DebateTask,
  FinalConsensus,
  ParticipantRole,
  RefereeDecision,
  RunEvent,
  RunDetail,
  RunConfig,
  SourceRecord,
  ToolInvocationRecord,
  TurnRecord,
  UserQuestionBatch,
  UserQuestionProposal,
  WorkspaceManifest,
} from "@/lib/types";

const refereeDecisionSchema = z.object({
  converged: z.boolean(),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  preferredDraft: z.enum(["participant_a", "participant_b", "tie"]),
  requiredNextFocus: z.string().min(1),
  remainingDisagreements: z.string().min(1),
  needsUserInput: z.boolean(),
  questionBatch: z
    .object({
      questions: z
        .array(
          z.object({
            id: z.string().min(1).optional(),
            question: z.string().min(1),
            notePlaceholder: z.string().optional(),
            options: z
              .array(
                z.object({
                  id: z.string().min(1),
                  label: z.string().min(1),
                  description: z.string().min(1),
                  recommended: z.boolean().optional(),
                }),
              )
              .min(2)
              .max(4),
          }),
        )
        .min(1)
        .max(3),
  })
    .optional(),
});

const taskPlanSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        objective: z.string().min(1),
        completionCriteria: z.string().min(1),
      }),
    )
    .min(1)
    .max(5),
});

interface ParticipantTurnResult {
  turn: TurnRecord;
  toolInvocations: ToolInvocationRecord[];
  sources: SourceRecord[];
  questionProposals: UserQuestionProposal[];
}

interface RunCheckpoint {
  taskPlan: DebateTask[];
  currentTaskIndex: number;
  answeredQuestionBatches: UserQuestionBatch[];
  collectedSources: SourceRecord[];
  latestA: ParticipantTurnResult | null;
  latestB: ParticipantTurnResult | null;
  latestCritiqueA: ParticipantTurnResult | null;
  latestCritiqueB: ParticipantTurnResult | null;
  previousDecision: RefereeDecision | null;
  refereeDecisions: RefereeDecision[];
  startTurnIndex: number;
}

interface ExecuteRunArgs {
  runId: string;
  config: RunConfig;
  workspaceManifest?: WorkspaceManifest | null;
  signal: AbortSignal;
  waitForAnswers: (batch: UserQuestionBatch, signal: AbortSignal) => Promise<UserQuestionBatch>;
}

function isoNow() {
  return new Date().toISOString();
}

function parseJsonFromModel<T>(raw: string, schema: z.ZodSchema<T>) {
  const trimmed = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
  return schema.parse(JSON.parse(trimmed));
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new Error("Run cancelled.");
  }
}

type RunEventWithoutId = RunEvent extends infer Event
  ? Event extends { runId: string }
    ? Omit<Event, "runId">
    : never
  : never;

function publish(runId: string, event: RunEventWithoutId) {
  const fullEvent = {
    ...(event as RunEvent),
    runId,
  } as RunEvent;
  runLiveStateStore.applyEvent(fullEvent);
  runEventBus.publish(fullEvent);
}

function publishTurnDelta(args: {
  runId: string;
  role: ActorRole;
  phase: TurnRecord["phase"];
  turnIndex: number;
  modelId: string;
  delta: string;
  content: string;
}) {
  publish(args.runId, {
    type: "turn_delta",
    role: args.role,
    phase: args.phase,
    turnIndex: args.turnIndex,
    modelId: args.modelId,
    delta: args.delta,
    content: args.content,
    at: isoNow(),
  });
}

function dedupeSources(sources: SourceRecord[]) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.url}|${source.title}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function toParticipantTurnResult(turn: TurnRecord): ParticipantTurnResult {
  return {
    turn,
    toolInvocations: [],
    sources: [],
    questionProposals: [],
  };
}

function createQuestionBatch(runId: string, questions: z.infer<typeof refereeDecisionSchema>["questionBatch"]) {
  if (!questions) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    runId,
    status: "pending" as const,
    questions: questions.questions.map((question) => ({
      id: question.id ?? crypto.randomUUID(),
      question: question.question,
      notePlaceholder:
        question.notePlaceholder ??
        "Add optional context or constraints for this answer.",
      options: question.options.map((option) => ({
        ...option,
        recommended: option.recommended ?? false,
      })),
    })),
    answers: null,
    createdAt: isoNow(),
    answeredAt: null,
  };
}

function toTaskPlan(tasks: z.infer<typeof taskPlanSchema>["tasks"]): DebateTask[] {
  return tasks.map((task) => ({
    id: crypto.randomUUID(),
    title: task.title.trim(),
    objective: task.objective.trim(),
    completionCriteria: task.completionCriteria.trim(),
  }));
}

function getCurrentTask(taskPlan: DebateTask[], currentTaskIndex: number) {
  return taskPlan[currentTaskIndex] ?? null;
}

function hasPlanningTurn(turns: TurnRecord[]) {
  return turns.some((turn) => turn.role === "referee" && turn.phase === "planning");
}

function assertMilestonePlan(taskPlan: DebateTask[]) {
  if (taskPlan.length === 0) {
    throw new Error("A persisted milestone plan is required before the debate cycle can start.");
  }
}

function decisionRequestsAnotherPass(decision: RefereeDecision) {
  if (!decision.converged) {
    return false;
  }

  const focus = decision.requiredNextFocus.trim().toLowerCase();
  if (!focus || focus === "none" || focus === "n/a") {
    return false;
  }

  return /\b(round|rewrite|revise|revision|another pass|next pass|continue|full rewrite|converge)\b/.test(
    focus,
  );
}

function normalizeDraft(content: string) {
  return content.replace(/\s+/g, " ").trim();
}

function pickPreferredTurn(args: {
  participantATurn: TurnRecord;
  participantBTurn: TurnRecord;
  preferredDraft: RefereeDecision["preferredDraft"];
}) {
  if (args.preferredDraft === "participant_b") {
    return args.participantBTurn;
  }

  if (args.preferredDraft === "participant_a") {
    return args.participantATurn;
  }

  return normalizeDraft(args.participantATurn.content) ===
    normalizeDraft(args.participantBTurn.content)
    ? args.participantATurn
    : null;
}

function buildSelectionRationale(args: {
  finalDecision: RefereeDecision;
  taskPlan: DebateTask[];
  selectedTurn: TurnRecord;
  usedTieFallback?: boolean;
}) {
  const completedTasks = args.taskPlan
    .map((task, index) => `${index + 1}. ${task.title}`)
    .join("\n");

  return [
    `Selected final draft: ${args.selectedTurn.role} (${args.selectedTurn.modelId}).`,
    args.usedTieFallback
      ? "The referee left the final preference as a tie, so the coordinator used participant A as the canonical final draft."
      : null,
    "",
    `Referee summary: ${args.finalDecision.summary}`,
    "",
    `Completed milestone path:\n${completedTasks}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function assertCompletedCycle(args: {
  currentTaskIndex: number;
  finalDecision: RefereeDecision | null;
  participantATurn: TurnRecord | null;
  participantBTurn: TurnRecord | null;
  participantACritique: TurnRecord | null;
  participantBCritique: TurnRecord | null;
  taskPlan: DebateTask[];
}) {
  assertMilestonePlan(args.taskPlan);

  if (!getCurrentTask(args.taskPlan, args.currentTaskIndex)) {
    throw new Error("No current milestone is available for finalization.");
  }

  if (!args.finalDecision) {
    throw new Error("A referee decision is required before finalization.");
  }

  if (
    !args.participantATurn ||
    !args.participantBTurn ||
    !["proposal", "revision"].includes(args.participantATurn.phase) ||
    !["proposal", "revision"].includes(args.participantBTurn.phase)
  ) {
    throw new Error("Finalization requires completed participant proposal or revision outputs.");
  }

  if (
    !args.participantACritique ||
    !args.participantBCritique ||
    args.participantACritique.phase !== "critique" ||
    args.participantBCritique.phase !== "critique"
  ) {
    throw new Error("Finalization requires both participant critiques for the completed cycle.");
  }

  const completedTurnIndex = args.finalDecision.turnIndex;
  if (
    args.participantATurn.turnIndex !== completedTurnIndex ||
    args.participantBTurn.turnIndex !== completedTurnIndex ||
    args.participantACritique.turnIndex !== completedTurnIndex ||
    args.participantBCritique.turnIndex !== completedTurnIndex
  ) {
    throw new Error("Finalization requires proposal, critique, and referee outputs from the same cycle.");
  }
}

export class DebateCoordinator {
  constructor(private readonly adapter: ProviderAdapter) {}

  async executeRun(args: ExecuteRunArgs) {
    return this.runWithCheckpoint(
      args,
      {
        taskPlan: [],
        currentTaskIndex: 0,
        answeredQuestionBatches: [],
        collectedSources: [],
        latestA: null,
        latestB: null,
        latestCritiqueA: null,
        latestCritiqueB: null,
        previousDecision: null,
        refereeDecisions: [],
        startTurnIndex: 0,
      },
      { statusMessage: "Run started." },
    );
  }

  async resumeRun(
    args: ExecuteRunArgs & {
      carryForwardDecision?: boolean;
      mode?: "turn_loop" | "final_synthesis";
      run: RunDetail;
    },
  ) {
    if (!hasPlanningTurn(args.run.turns) || args.run.taskPlan.length === 0) {
      throw new Error(
        "This failed run does not have a persisted milestone-planning step. Start a new run instead of retrying this legacy run.",
      );
    }

    return this.runWithCheckpoint(
      args,
      this.buildCheckpointFromRun(args.run, {
        carryForwardDecision:
          args.mode === "final_synthesis" || args.carryForwardDecision === true,
      }),
      {
        finalizationOnly: args.mode === "final_synthesis",
        statusMessage:
          args.mode === "final_synthesis"
            ? "Retrying final selection."
            : "Run resumed from failure.",
      },
    );
  }

  private buildCheckpointFromRun(
    run: RunDetail,
    options: {
      carryForwardDecision: boolean;
    },
  ): RunCheckpoint {
    const participantTurns = [...run.turns]
      .filter((turn) => turn.turnIndex >= run.currentTurn || options.carryForwardDecision)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const latestATurn = options.carryForwardDecision
      ? participantTurns
          .filter(
            (turn) =>
              turn.role === "participant_a" &&
              (turn.phase === "proposal" || turn.phase === "revision"),
          )
          .at(-1)
      : null;
    const latestBTurn = options.carryForwardDecision
      ? participantTurns
          .filter(
            (turn) =>
              turn.role === "participant_b" &&
              (turn.phase === "proposal" || turn.phase === "revision"),
          )
          .at(-1)
      : null;
    const latestACritique = options.carryForwardDecision
      ? participantTurns
          .filter((turn) => turn.role === "participant_a" && turn.phase === "critique")
          .at(-1)
      : null;
    const latestBCritique = options.carryForwardDecision
      ? participantTurns
          .filter((turn) => turn.role === "participant_b" && turn.phase === "critique")
          .at(-1)
      : null;
    const previousDecision =
      options.carryForwardDecision ? (run.refereeDecisions.at(-1) ?? null) : null;

    return {
      taskPlan: [...run.taskPlan],
      currentTaskIndex: run.currentTaskIndex,
      answeredQuestionBatches: run.questionBatches.filter(
        (batch) => batch.status === "answered" || batch.status === "skipped",
      ),
      collectedSources: [...run.sources],
      latestA: latestATurn ? toParticipantTurnResult(latestATurn) : null,
      latestB: latestBTurn ? toParticipantTurnResult(latestBTurn) : null,
      latestCritiqueA: latestACritique ? toParticipantTurnResult(latestACritique) : null,
      latestCritiqueB: latestBCritique ? toParticipantTurnResult(latestBCritique) : null,
      previousDecision,
      refereeDecisions: [...run.refereeDecisions],
      startTurnIndex: run.currentTurn,
    };
  }

  private async runWithCheckpoint(
    args: ExecuteRunArgs,
    checkpoint: RunCheckpoint,
    options: {
      finalizationOnly?: boolean;
      statusMessage: string;
    },
  ) {
    const { runId, config, workspaceManifest, signal, waitForAnswers } = args;
    const taskPlan =
      checkpoint.taskPlan.length > 0
        ? [...checkpoint.taskPlan]
        : await this.createTaskPlan({
            runId,
            config,
            signal,
          });
    assertMilestonePlan(taskPlan);
    let currentTaskIndex = checkpoint.currentTaskIndex;
    let previousDecision: RefereeDecision | null = checkpoint.previousDecision;
    const answeredQuestionBatches = [...checkpoint.answeredQuestionBatches];
    const collectedSources = [...checkpoint.collectedSources];
    const refereeDecisions = [...checkpoint.refereeDecisions];
    let latestA: ParticipantTurnResult | null = checkpoint.latestA;
    let latestB: ParticipantTurnResult | null = checkpoint.latestB;
    let latestCritiqueA: ParticipantTurnResult | null = checkpoint.latestCritiqueA;
    let latestCritiqueB: ParticipantTurnResult | null = checkpoint.latestCritiqueB;
    const initialTurnIndex = options.finalizationOnly
      ? latestA?.turn.turnIndex ?? checkpoint.startTurnIndex
      : checkpoint.startTurnIndex;

    if (checkpoint.taskPlan.length === 0) {
      await saveTaskPlan(runId, taskPlan);
      publish(runId, {
        type: "status",
        status: "running",
        message: `Milestone plan created with ${taskPlan.length} step${taskPlan.length === 1 ? "" : "s"}.`,
        at: isoNow(),
      });
    }

    await updateRunStatus(runId, "running", {
      currentTurn: initialTurnIndex,
      currentTaskIndex,
      activeQuestionBatchId: null,
    });
    publish(runId, {
      type: "status",
      status: "running",
      message: options.statusMessage,
      at: isoNow(),
    });

    try {
      if (options.finalizationOnly) {
        assertCompletedCycle({
          currentTaskIndex,
          finalDecision: previousDecision,
          participantATurn: latestA?.turn ?? null,
          participantBTurn: latestB?.turn ?? null,
          participantACritique: latestCritiqueA?.turn ?? null,
          participantBCritique: latestCritiqueB?.turn ?? null,
          taskPlan,
        });

        const stopReason = previousDecision?.converged ? "converged" : "max_turns";
        const finalConsensus = await this.finalizeConsensus({
          runId,
          participantATurn: latestA!.turn,
          participantBTurn: latestB!.turn,
          finalDecision: previousDecision!,
          taskPlan,
          currentTaskIndex,
          sources: dedupeSources(collectedSources),
        });

        await saveFinalConsensus(runId, finalConsensus, stopReason);
        publish(runId, {
          type: "completed",
          finalConsensus,
          stopReason,
          at: isoNow(),
        });
        return;
      }

      for (
        let turnIndex = checkpoint.startTurnIndex;
        turnIndex < config.maxTurns;
        turnIndex += 1
      ) {
        assertNotAborted(signal);
        const currentTask = getCurrentTask(taskPlan, currentTaskIndex);
        if (!currentTask) {
          throw new Error("The task plan has no current task.");
        }

        await updateRunStatus(runId, "running", {
          currentTurn: turnIndex,
          currentTaskIndex,
        });
        publish(runId, {
          type: "status",
          status: "running",
          message: `Participants are drafting milestone ${currentTaskIndex + 1}: ${currentTask.title}.`,
          at: isoNow(),
        });

        const participantResultPromises: [
          Promise<ParticipantTurnResult>,
          Promise<ParticipantTurnResult>,
        ] = [
          this.executeParticipantTurn({
            runId,
            config,
            role: "participant_a",
            participant: config.participantA,
            turnIndex,
            workspaceManifest,
            phase: previousDecision ? "revision" : "proposal",
            taskPlan,
            currentTaskIndex,
            previousOwnTurn: latestA?.turn ?? null,
            previousOpponentTurn: latestB?.turn ?? null,
            previousOwnCritique: latestCritiqueA?.turn ?? null,
            previousOpponentCritique: latestCritiqueB?.turn ?? null,
            previousDecision,
            answeredQuestionBatches,
            signal,
          }),
          this.executeParticipantTurn({
            runId,
            config,
            role: "participant_b",
            participant: config.participantB,
            turnIndex,
            workspaceManifest,
            phase: previousDecision ? "revision" : "proposal",
            taskPlan,
            currentTaskIndex,
            previousOwnTurn: latestB?.turn ?? null,
            previousOpponentTurn: latestA?.turn ?? null,
            previousOwnCritique: latestCritiqueB?.turn ?? null,
            previousOpponentCritique: latestCritiqueA?.turn ?? null,
            previousDecision,
            answeredQuestionBatches,
            signal,
          }),
        ];

        const participantResults = await Promise.all(participantResultPromises);

        const [participantAResult, participantBResult]: [
          ParticipantTurnResult,
          ParticipantTurnResult,
        ] = participantResults;

        latestA = participantAResult;
        latestB = participantBResult;
        collectedSources.push(...participantAResult.sources, ...participantBResult.sources);
        publish(runId, {
          type: "status",
          status: "running",
          message: `Participants are critiquing each other's milestone ${currentTaskIndex + 1} outputs.`,
          at: isoNow(),
        });

        const critiqueResultPromises: [
          Promise<ParticipantTurnResult>,
          Promise<ParticipantTurnResult>,
        ] = [
          this.executeParticipantTurn({
            runId,
            config,
            role: "participant_a",
            participant: config.participantA,
            turnIndex,
            workspaceManifest,
            phase: "critique",
            taskPlan,
            currentTaskIndex,
            previousOwnTurn: participantAResult.turn,
            previousOpponentTurn: participantBResult.turn,
            previousOwnCritique: null,
            previousOpponentCritique: null,
            previousDecision,
            answeredQuestionBatches,
            signal,
          }),
          this.executeParticipantTurn({
            runId,
            config,
            role: "participant_b",
            participant: config.participantB,
            turnIndex,
            workspaceManifest,
            phase: "critique",
            taskPlan,
            currentTaskIndex,
            previousOwnTurn: participantBResult.turn,
            previousOpponentTurn: participantAResult.turn,
            previousOwnCritique: null,
            previousOpponentCritique: null,
            previousDecision,
            answeredQuestionBatches,
            signal,
          }),
        ];

        const [participantACritique, participantBCritique] = await Promise.all(
          critiqueResultPromises,
        );
        latestCritiqueA = participantACritique;
        latestCritiqueB = participantBCritique;
        collectedSources.push(...participantACritique.sources, ...participantBCritique.sources);
        publish(runId, {
          type: "status",
          status: "running",
          message: `Referee is evaluating milestone ${currentTaskIndex + 1}: ${currentTask.title}.`,
          at: isoNow(),
        });

        const refereeResult = await this.executeRefereeTurn({
          runId,
          config,
          turnIndex,
          taskPlan,
          currentTaskIndex,
          participantATurn: participantAResult.turn,
          participantBTurn: participantBResult.turn,
          participantACritique: participantACritique.turn,
          participantBCritique: participantBCritique.turn,
          previousDecision,
          answeredQuestionBatches,
          questionProposals: [
            {
              role: "participant_a",
              proposals: [
                ...participantAResult.questionProposals,
                ...participantACritique.questionProposals,
              ],
            },
            {
              role: "participant_b",
              proposals: [
                ...participantBResult.questionProposals,
                ...participantBCritique.questionProposals,
              ],
            },
          ],
          signal,
        });

        previousDecision = refereeResult.decision;
        refereeDecisions.push(refereeResult.decision);

        if (refereeResult.decision.questionBatch) {
          await saveQuestionBatch(refereeResult.decision.questionBatch);
          publish(runId, {
            type: "question_batch",
            batch: refereeResult.decision.questionBatch,
            at: isoNow(),
          });

          const answeredBatch = await waitForAnswers(
            refereeResult.decision.questionBatch,
            signal,
          );
          answeredQuestionBatches.push(answeredBatch);
          publish(runId, {
            type: "question_batch_answered",
            batch: answeredBatch,
            at: isoNow(),
          });
        }

        const isFinalTask = currentTaskIndex >= taskPlan.length - 1;
        if (
          refereeResult.decision.converged &&
          isFinalTask &&
          decisionRequestsAnotherPass(refereeResult.decision) &&
          turnIndex < config.maxTurns - 1
        ) {
          publish(runId, {
            type: "status",
            status: "running",
            message:
              "Referee marked the final task converged but still asked for another pass. Continuing debate.",
            at: isoNow(),
          });
          continue;
        }

        if (refereeResult.decision.converged && !isFinalTask) {
          const completedTaskTitle = currentTask.title;
          currentTaskIndex += 1;
          previousDecision = null;
          latestA = null;
          latestB = null;
          latestCritiqueA = null;
          latestCritiqueB = null;
          await updateRunStatus(runId, "running", {
            currentTurn: turnIndex,
            currentTaskIndex,
          });
          const nextTask = getCurrentTask(taskPlan, currentTaskIndex);
          publish(runId, {
            type: "status",
            status: "running",
            message: nextTask
              ? `Milestone "${completedTaskTitle}" completed. Advancing to ${nextTask.title}.`
              : `Milestone "${completedTaskTitle}" completed. Advancing to the next step.`,
            at: isoNow(),
          });
          continue;
        }

        if (refereeResult.decision.converged) {
          assertCompletedCycle({
            currentTaskIndex,
            finalDecision: refereeResult.decision,
            participantATurn: participantAResult.turn,
            participantBTurn: participantBResult.turn,
            participantACritique: participantACritique.turn,
            participantBCritique: participantBCritique.turn,
            taskPlan,
          });
          const finalConsensus = await this.finalizeConsensus({
            runId,
            participantATurn: participantAResult.turn,
            participantBTurn: participantBResult.turn,
            finalDecision: refereeResult.decision,
            taskPlan,
            currentTaskIndex,
            sources: dedupeSources(collectedSources),
          });

          await saveFinalConsensus(runId, finalConsensus, "converged");
          publish(runId, {
            type: "completed",
            finalConsensus,
            stopReason: "converged",
            at: isoNow(),
          });
          return;
        }
      }

      assertCompletedCycle({
        currentTaskIndex,
        finalDecision: previousDecision,
        participantATurn: latestA?.turn ?? null,
        participantBTurn: latestB?.turn ?? null,
        participantACritique: latestCritiqueA?.turn ?? null,
        participantBCritique: latestCritiqueB?.turn ?? null,
        taskPlan,
      });

      const finalConsensus = await this.finalizeConsensus({
        runId,
        participantATurn: latestA!.turn,
        participantBTurn: latestB!.turn,
        finalDecision: previousDecision!,
        taskPlan,
        currentTaskIndex,
        sources: dedupeSources(collectedSources),
      });

      await saveFinalConsensus(runId, finalConsensus, "max_turns");
      publish(runId, {
        type: "completed",
        finalConsensus,
        stopReason: "max_turns",
        at: isoNow(),
      });
    } catch (error) {
      if (signal.aborted) {
        await updateRunStatus(runId, "cancelled", { stopReason: "user_cancelled" });
        publish(runId, {
          type: "status",
          status: "cancelled",
          stopReason: "user_cancelled",
          message: "Run cancelled by the user.",
          at: isoNow(),
        });
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown run failure";
      await updateRunStatus(runId, "failed", {
        stopReason: "failed",
        errorText: message,
      });
      publish(runId, {
        type: "status",
        status: "failed",
        stopReason: "failed",
        message,
        at: isoNow(),
      });
      throw error;
    }
  }

  private async createTaskPlan(args: {
    runId: string;
    config: RunConfig;
    signal: AbortSignal;
  }) {
    assertNotAborted(args.signal);
    const start = Date.now();
    const turnIndex = -1;
    publish(args.runId, {
      type: "turn_started",
      role: "referee",
      phase: "planning",
      turnIndex,
      modelId: args.config.referee.modelId,
      at: isoNow(),
    });
    publish(args.runId, {
      type: "status",
      status: "running",
      message: "Referee is planning the milestone list.",
      at: isoNow(),
    });

    const response = await this.adapter.createChatStream({
      modelId: args.config.referee.modelId,
      responseFormat: "json_object",
      temperature: 0.1,
      signal: args.signal,
      onTextDelta: ({ delta, content }) => {
        publishTurnDelta({
          runId: args.runId,
          role: "referee",
          phase: "planning",
          turnIndex,
          modelId: args.config.referee.modelId,
          delta,
          content,
        });
      },
      messages: [
        {
          role: "system",
          content: buildTaskPlanSystemPrompt(),
        },
        {
          role: "user",
          content: buildTaskPlanUserPrompt(args.config.taskPrompt),
        },
      ],
    });

    const parsed = parseJsonFromModel(response.content, taskPlanSchema);
    const taskPlan = toTaskPlan(parsed.tasks);
    const planningTurn: TurnRecord = {
      id: crypto.randomUUID(),
      runId: args.runId,
      turnIndex,
      role: "referee",
      phase: "planning",
      modelId: args.config.referee.modelId,
      content: JSON.stringify(parsed, null, 2),
      summary: `Generated ${taskPlan.length} task${taskPlan.length === 1 ? "" : "s"}.`,
      latencyMs: Date.now() - start,
      tokenUsage: response.usage ?? null,
      createdAt: isoNow(),
    };

    await recordTurn(planningTurn);
    publish(args.runId, {
      type: "turn_completed",
      turn: planningTurn,
      at: isoNow(),
    });

    return taskPlan;
  }

  private async finalizeConsensus(args: {
    runId: string;
    participantATurn: TurnRecord;
    participantBTurn: TurnRecord;
    finalDecision: RefereeDecision;
    taskPlan: DebateTask[];
    currentTaskIndex: number;
    sources: SourceRecord[];
  }): Promise<FinalConsensus> {
    const preferredTurn = pickPreferredTurn({
      participantATurn: args.participantATurn,
      participantBTurn: args.participantBTurn,
      preferredDraft: args.finalDecision.preferredDraft,
    });
    const usedTieFallback = !preferredTurn;
    const selectedTurn = preferredTurn ?? args.participantATurn;
    if (selectedTurn.role === "referee") {
      throw new Error("Final selection cannot be authored by the referee.");
    }

    const finalConsensus: FinalConsensus = {
      solution: selectedTurn.content.trim(),
      rationale: buildSelectionRationale({
        finalDecision: args.finalDecision,
        taskPlan: args.taskPlan.slice(0, args.currentTaskIndex + 1),
        selectedTurn,
        usedTieFallback,
      }),
      sources: args.sources,
    };

    const finalTurn: TurnRecord = {
      id: crypto.randomUUID(),
      runId: args.runId,
      turnIndex: selectedTurn.turnIndex,
      role: selectedTurn.role,
      phase: "final",
      modelId: selectedTurn.modelId,
      content: finalConsensus.solution,
      summary: `Selected as the final draft with referee confidence ${Math.round(args.finalDecision.confidence * 100)}%.`,
      latencyMs: selectedTurn.latencyMs ?? null,
      tokenUsage: selectedTurn.tokenUsage ?? null,
      createdAt: isoNow(),
    };

    await recordTurn(finalTurn);

    return finalConsensus;
  }

  private async executeParticipantTurn(args: {
    runId: string;
    config: RunConfig;
    role: ParticipantRole;
    participant: RunConfig["participantA"];
    turnIndex: number;
    workspaceManifest?: WorkspaceManifest | null;
    phase: "proposal" | "revision" | "critique";
    taskPlan: DebateTask[];
    currentTaskIndex: number;
    previousOwnTurn?: TurnRecord | null;
    previousOpponentTurn?: TurnRecord | null;
    previousOwnCritique?: TurnRecord | null;
    previousOpponentCritique?: TurnRecord | null;
    previousDecision?: RefereeDecision | null;
    answeredQuestionBatches: UserQuestionBatch[];
    signal: AbortSignal;
  }): Promise<ParticipantTurnResult> {
    const start = Date.now();
    const turnId = crypto.randomUUID();

    if (
      args.phase === "critique" &&
      (!args.previousOwnTurn || !args.previousOpponentTurn)
    ) {
      throw new Error(`${args.role} cannot enter critique phase without both participant outputs.`);
    }

    publish(args.runId, {
      type: "turn_started",
      role: args.role,
      phase: args.phase,
      turnIndex: args.turnIndex,
      modelId: args.participant.modelId,
      at: isoNow(),
    });

    const messages: ProviderMessage[] = [
      {
        role: "system",
        content: buildParticipantSystemPrompt(
          args.role,
          args.participant.persona,
          args.workspaceManifest,
        ),
      },
      {
        role: "user",
        content:
          args.phase === "critique"
            ? buildParticipantCritiqueUserPrompt({
                taskPrompt: args.config.taskPrompt,
                taskPlan: args.taskPlan,
                currentTaskIndex: args.currentTaskIndex,
                turnIndex: args.turnIndex,
                ownTurn: args.previousOwnTurn!,
                opponentTurn: args.previousOpponentTurn!,
                previousDecision: args.previousDecision,
                answeredQuestionBatches: args.answeredQuestionBatches,
              })
            : buildParticipantUserPrompt({
                taskPrompt: args.config.taskPrompt,
                taskPlan: args.taskPlan,
                currentTaskIndex: args.currentTaskIndex,
                turnIndex: args.turnIndex,
                phase: args.phase,
                previousOwnTurn: args.previousOwnTurn,
                previousOpponentTurn: args.previousOpponentTurn,
                previousOwnCritique: args.previousOwnCritique,
                previousOpponentCritique: args.previousOpponentCritique,
                previousDecision: args.previousDecision,
                answeredQuestionBatches: args.answeredQuestionBatches,
              }),
      },
    ];

    const toolInvocations: ToolInvocationRecord[] = [];
    const collectedSources: SourceRecord[] = [];
    const questionProposals: UserQuestionProposal[] = [];
    let latestUsage: TurnRecord["tokenUsage"] = null;

    for (let loopCount = 0; loopCount < 6; loopCount += 1) {
      assertNotAborted(args.signal);
      const response = await this.adapter.createChatStream({
        modelId: args.participant.modelId,
        messages,
        tools: participantToolDefinitions,
        temperature: 0.3,
        signal: args.signal,
        onTextDelta: ({ delta, content }) => {
          publishTurnDelta({
            runId: args.runId,
            role: args.role,
            phase: args.phase,
            turnIndex: args.turnIndex,
            modelId: args.participant.modelId,
            delta,
            content,
          });
        },
      });

      latestUsage = response.usage ?? null;

      if (response.toolCalls.length === 0) {
        const directSources = (response.sources ?? []).map((source) => ({
          ...source,
          turnId,
        }));
        if (directSources.length > 0) {
          await recordSourceRecords(args.runId, directSources);
          collectedSources.push(...directSources);
        }

        const turn: TurnRecord = {
          id: turnId,
          runId: args.runId,
          turnIndex: args.turnIndex,
          role: args.role,
          phase: args.phase,
          modelId: args.participant.modelId,
          content: response.content.trim(),
          summary: null,
          latencyMs: Date.now() - start,
          tokenUsage: latestUsage,
          createdAt: isoNow(),
        };
        await recordTurn(turn);
        publish(args.runId, {
          type: "turn_completed",
          turn,
          at: isoNow(),
        });

        return {
          turn,
          toolInvocations,
          sources: collectedSources,
          questionProposals,
        };
      }

      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      for (const toolCall of response.toolCalls) {
        const result = await executeTool(toolCall.name, toolCall.arguments, {
          runId: args.runId,
          turnId,
          role: args.role,
          modelId: args.participant.modelId,
          searchBackend: args.config.searchBackend,
          workspaceManifest: args.workspaceManifest,
        });

        await recordToolInvocation(result.invocation);
        if (result.sources.length > 0) {
          await recordSourceRecords(args.runId, result.sources);
          collectedSources.push(...result.sources);
        }

        toolInvocations.push(result.invocation);
        if (result.questionProposals?.length) {
          questionProposals.push(...result.questionProposals);
        }

        publish(args.runId, {
          type: "tool_event",
          tool: result.invocation,
          sources: result.sources,
          at: isoNow(),
        });

        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: result.content,
        });
      }
    }

    throw new Error(`${args.role} exceeded the maximum tool iteration count.`);
  }

  private async executeRefereeTurn(args: {
    runId: string;
    config: RunConfig;
    turnIndex: number;
    taskPlan: DebateTask[];
    currentTaskIndex: number;
    participantATurn: TurnRecord;
    participantBTurn: TurnRecord;
    participantACritique?: TurnRecord | null;
    participantBCritique?: TurnRecord | null;
    previousDecision?: RefereeDecision | null;
    answeredQuestionBatches: UserQuestionBatch[];
    questionProposals: Array<{
      role: ParticipantRole;
      proposals: UserQuestionProposal[];
    }>;
    signal: AbortSignal;
  }) {
    assertNotAborted(args.signal);
    if (!args.participantACritique || !args.participantBCritique) {
      throw new Error("The referee cannot evaluate a milestone before both critiques are complete.");
    }
    if (
      args.participantATurn.turnIndex !== args.turnIndex ||
      args.participantBTurn.turnIndex !== args.turnIndex ||
      args.participantACritique.turnIndex !== args.turnIndex ||
      args.participantBCritique.turnIndex !== args.turnIndex
    ) {
      throw new Error("The referee can only evaluate a completed cycle for the current milestone.");
    }
    publish(args.runId, {
      type: "turn_started",
      role: "referee",
      phase: "referee",
      turnIndex: args.turnIndex,
      modelId: args.config.referee.modelId,
      at: isoNow(),
    });

    const response = await this.adapter.createChatStream({
      modelId: args.config.referee.modelId,
      responseFormat: "json_object",
      temperature: 0.2,
      signal: args.signal,
      onTextDelta: ({ delta, content }) => {
        publishTurnDelta({
          runId: args.runId,
          role: "referee",
          phase: "referee",
          turnIndex: args.turnIndex,
          modelId: args.config.referee.modelId,
          delta,
          content,
        });
      },
      messages: [
        {
          role: "system",
          content: buildRefereeSystemPrompt(args.config.referee.persona),
        },
        {
          role: "user",
          content: buildRefereeUserPrompt({
            taskPrompt: args.config.taskPrompt,
            taskPlan: args.taskPlan,
            currentTaskIndex: args.currentTaskIndex,
            turnIndex: args.turnIndex,
            participantATurn: args.participantATurn,
            participantBTurn: args.participantBTurn,
            participantACritique: args.participantACritique,
            participantBCritique: args.participantBCritique,
            previousDecision: args.previousDecision,
            answeredQuestionBatches: args.answeredQuestionBatches,
            questionProposals: args.questionProposals,
          }),
        },
      ],
    });

    const parsedDecision = parseJsonFromModel(response.content, refereeDecisionSchema);
    const questionBatch =
      parsedDecision.needsUserInput && parsedDecision.questionBatch
        ? createQuestionBatch(args.runId, parsedDecision.questionBatch)
        : null;

    const decision: RefereeDecision = {
      id: crypto.randomUUID(),
      runId: args.runId,
      turnIndex: args.turnIndex,
      converged: parsedDecision.converged,
      confidence: parsedDecision.confidence,
      summary: parsedDecision.summary,
      preferredDraft: parsedDecision.preferredDraft,
      requiredNextFocus: parsedDecision.requiredNextFocus,
      remainingDisagreements: parsedDecision.remainingDisagreements,
      needsUserInput: parsedDecision.needsUserInput && !!questionBatch,
      questionBatch,
      createdAt: isoNow(),
    };

    const turn: TurnRecord = {
      id: crypto.randomUUID(),
      runId: args.runId,
      turnIndex: args.turnIndex,
      role: "referee",
      phase: "referee",
      modelId: args.config.referee.modelId,
      content: JSON.stringify(parsedDecision, null, 2),
      summary: parsedDecision.summary,
      latencyMs: null,
      tokenUsage: response.usage ?? null,
      createdAt: isoNow(),
    };

    await recordTurn(turn);
    await recordRefereeDecision(decision);
    publish(args.runId, {
      type: "turn_completed",
      turn,
      at: isoNow(),
    });
    publish(args.runId, {
      type: "referee_decision",
      decision,
      at: isoNow(),
    });

    return { turn, decision };
  }

}
