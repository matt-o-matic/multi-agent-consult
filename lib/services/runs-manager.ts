import "server-only";

import { normalizeDebateMode } from "@/lib/debate-mode";
import {
  answerQuestionBatch as persistQuestionBatchAnswers,
  deleteRunArtifactsForRetry,
  getQuestionBatch,
  getRunDetail,
  prepareRunForRetry,
} from "@/lib/data/run-store";
import { getOpenRouterAdapter } from "@/lib/providers/openrouter";
import { DebateCoordinator } from "@/lib/services/debate/coordinator";
import { validateWorkspacePath } from "@/lib/services/workspace-tools";
import type {
  ParticipantRole,
  RunConfig,
  RunDetail,
  TurnPhase,
  UserQuestionBatch,
  WorkspaceManifest,
} from "@/lib/types";

interface ActiveRunState {
  abortController: AbortController;
  pendingQuestionBatch?: {
    batchId: string;
    resolve: (batch: UserQuestionBatch) => void;
    reject: (error: Error) => void;
  };
}

interface RetryPlan {
  carryForwardDecision?: boolean;
  currentMilestoneTurn: number;
  currentTurn: number;
  currentTaskIndex: number;
  deleteArtifacts?: Parameters<typeof deleteRunArtifactsForRetry>[0];
  mode: "final_synthesis" | "turn_loop";
}

function toRunConfig(run: RunDetail): RunConfig {
  return {
    taskPrompt: run.taskPrompt,
    maxTurns: run.maxTurns,
    debateMode: normalizeDebateMode(run.debateMode),
    searchBackend: run.searchBackend,
    workspaceMode: run.workspacePath ? "path" : "off",
    workspacePath: run.workspacePath ?? null,
    participantA: run.participantA,
    participantB: run.participantB,
    referee: run.referee,
  };
}

function latestParticipantTurn(
  run: RunDetail,
  role: ParticipantRole,
  phases?: TurnPhase[],
) {
  return [...run.turns]
    .filter(
      (turn) => turn.role === role && (!phases || phases.includes(turn.phase)),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
}

function hasPlanningTurn(run: RunDetail) {
  return run.turns.some((turn) => turn.role === "referee" && turn.phase === "planning");
}

function maxIso(values: Array<string | null | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => left.localeCompare(right))
    .at(-1);
}

export function buildRetryPlan(run: RunDetail): RetryPlan {
  if (run.status !== "failed") {
    throw new Error("Only failed runs can be retried.");
  }

  if (!hasPlanningTurn(run)) {
    throw new Error(
      "This failed run is missing its persisted milestone-planning step. Start a new run instead of retrying this legacy run.",
    );
  }

  if (run.finalConsensus || run.turns.some((turn) => turn.phase === "final")) {
    throw new Error("This run already has a final answer.");
  }

  if (run.questionBatches.some((batch) => batch.status === "pending")) {
    throw new Error("Resolve the pending referee question batch before retrying.");
  }

  if (run.taskPlan.length === 0) {
    return {
      currentMilestoneTurn: run.currentMilestoneTurn,
      currentTurn: run.currentTurn,
      currentTaskIndex: run.currentTaskIndex,
      mode: "turn_loop",
    };
  }

  const debateMode = normalizeDebateMode(run.debateMode);
  const latestDraftA = latestParticipantTurn(run, "participant_a", ["proposal", "revision"]);
  const latestDraftB = latestParticipantTurn(run, "participant_b", ["proposal", "revision"]);
  const latestCritiqueA = latestParticipantTurn(run, "participant_a", ["critique"]);
  const latestCritiqueB = latestParticipantTurn(run, "participant_b", ["critique"]);
  const lastDecision = run.refereeDecisions.at(-1) ?? null;
  const isFinalMilestone =
    run.taskPlan.length > 0 && run.currentTaskIndex === run.taskPlan.length - 1;
  const canRetryFinalSynthesis =
    isFinalMilestone &&
    !!lastDecision &&
    !!latestDraftA &&
    (debateMode === "writers_room" ? true : !!latestDraftB) &&
    (debateMode === "writers_room" ? true : !!latestCritiqueA) &&
    !!latestCritiqueB &&
    latestDraftA.turnIndex === lastDecision.turnIndex &&
    (debateMode === "writers_room" ||
      latestDraftB!.turnIndex === lastDecision.turnIndex) &&
    (debateMode === "writers_room" ||
      latestCritiqueA!.turnIndex === lastDecision.turnIndex) &&
    latestCritiqueB.turnIndex === lastDecision.turnIndex &&
    (lastDecision.converged || run.currentMilestoneTurn >= run.maxTurns - 1);

  if (canRetryFinalSynthesis) {
    return {
      currentMilestoneTurn: run.currentMilestoneTurn,
      currentTurn: lastDecision.turnIndex,
      currentTaskIndex: run.currentTaskIndex,
      mode: "final_synthesis",
    };
  }

  const stableDecisions = run.refereeDecisions.filter(
    (decision) =>
      !decision.needsUserInput ||
      decision.questionBatch?.status === "answered" ||
      decision.questionBatch?.status === "skipped",
  );
  const restartTurnIndex = (stableDecisions.at(-1)?.turnIndex ?? -1) + 1;
  const keptBatchIds = new Set(
    stableDecisions
      .map((decision) => decision.questionBatch?.id)
      .filter((batchId): batchId is string => Boolean(batchId)),
  );
  const checkpointAt =
    maxIso([
      run.createdAt,
      ...run.turns
        .filter((turn) => turn.turnIndex < restartTurnIndex)
        .map((turn) => turn.createdAt),
      ...stableDecisions.map((decision) => decision.createdAt),
      ...run.questionBatches
        .filter((batch) => keptBatchIds.has(batch.id))
        .flatMap((batch) => [batch.createdAt, batch.answeredAt]),
    ]) ?? run.createdAt;

  const turnIds = run.turns
    .filter((turn) => turn.turnIndex >= restartTurnIndex || turn.phase === "final")
    .map((turn) => turn.id);
  const deletedTurnIds = new Set(turnIds);
  const toolInvocationIds = run.toolInvocations
    .filter((tool) => deletedTurnIds.has(tool.turnId) || tool.createdAt > checkpointAt)
    .map((tool) => tool.id);
  const deletedToolIds = new Set(toolInvocationIds);
  const decisionIds = run.refereeDecisions
    .filter((decision) => decision.turnIndex >= restartTurnIndex)
    .map((decision) => decision.id);
  const deletedDecisionBatchIds = new Set(
    run.refereeDecisions
      .filter((decision) => decision.turnIndex >= restartTurnIndex)
      .map((decision) => decision.questionBatch?.id)
      .filter((batchId): batchId is string => Boolean(batchId)),
  );
  const batchIds = run.questionBatches
    .filter((batch) => deletedDecisionBatchIds.has(batch.id) || batch.createdAt > checkpointAt)
    .map((batch) => batch.id);
  const sourceIds = run.sources
    .filter(
      (source) =>
        (source.turnId ? deletedTurnIds.has(source.turnId) : false) ||
        (source.toolInvocationId ? deletedToolIds.has(source.toolInvocationId) : false) ||
        source.createdAt > checkpointAt,
    )
    .map((source) => source.id);

  return {
    carryForwardDecision: stableDecisions.at(-1)?.converged ? false : stableDecisions.length > 0,
    currentMilestoneTurn: run.currentMilestoneTurn,
    currentTurn: restartTurnIndex,
    currentTaskIndex: run.currentTaskIndex,
    deleteArtifacts: {
      batchIds,
      decisionIds,
      sourceIds,
      toolInvocationIds,
      turnIds,
    },
    mode: "turn_loop",
  };
}

class RunsManager {
  private activeRuns = new Map<string, ActiveRunState>();

  async startRun(args: {
    runId: string;
    config: RunConfig;
    workspaceManifest?: WorkspaceManifest | null;
  }) {
    const coordinator = new DebateCoordinator(getOpenRouterAdapter());

    this.launchRun(args.runId, (signal) =>
      coordinator.executeRun({
        runId: args.runId,
        config: args.config,
        workspaceManifest: args.workspaceManifest,
        signal,
        waitForAnswers: (batch, waitSignal) =>
          this.waitForAnswers(args.runId, batch, waitSignal),
      }),
    );
  }

  async retryRun(runId: string) {
    if (this.activeRuns.size > 0) {
      throw new Error("Only one active run is supported in v1.");
    }

    const run = await getRunDetail(runId);
    if (!run) {
      throw new Error("Run not found.");
    }

    const plan = buildRetryPlan(run);
    if (plan.deleteArtifacts) {
      await deleteRunArtifactsForRetry(plan.deleteArtifacts);
    }

    await prepareRunForRetry(runId, {
      currentMilestoneTurn: plan.currentMilestoneTurn,
      currentTurn: plan.currentTurn,
      currentTaskIndex: plan.currentTaskIndex,
    });

    const refreshedRun = await getRunDetail(runId);
    if (!refreshedRun) {
      throw new Error("Run could not be loaded after retry preparation.");
    }

    const workspaceManifest =
      refreshedRun.workspacePath && refreshedRun.workspacePath.trim()
        ? await validateWorkspacePath(refreshedRun.workspacePath)
        : null;
    const config = toRunConfig(refreshedRun);
    const coordinator = new DebateCoordinator(getOpenRouterAdapter());

    this.launchRun(runId, (signal) =>
      coordinator.resumeRun({
        runId,
        run: refreshedRun,
        carryForwardDecision: plan.carryForwardDecision,
        mode: plan.mode,
        config,
        workspaceManifest,
        signal,
        waitForAnswers: (batch, waitSignal) =>
          this.waitForAnswers(runId, batch, waitSignal),
      }),
    );

    return getRunDetail(runId);
  }

  cancelRun(runId: string) {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) {
      return false;
    }

    activeRun.abortController.abort();
    return true;
  }

  async answerQuestionBatch(
    runId: string,
    batchId: string,
    answers: UserQuestionBatch["answers"],
  ) {
    const batch = await persistQuestionBatchAnswers(runId, batchId, answers);
    if (!batch) {
      throw new Error("Question batch not found.");
    }

    const activeRun = this.activeRuns.get(runId);
    if (
      activeRun?.pendingQuestionBatch &&
      activeRun.pendingQuestionBatch.batchId === batchId
    ) {
      activeRun.pendingQuestionBatch.resolve(batch);
      activeRun.pendingQuestionBatch = undefined;
    }

    return batch;
  }

  private launchRun(
    runId: string,
    runner: (signal: AbortSignal) => Promise<void>,
  ) {
    if (this.activeRuns.size > 0) {
      throw new Error("Only one active run is supported in v1.");
    }

    const abortController = new AbortController();
    this.activeRuns.set(runId, { abortController });

    void runner(abortController.signal).finally(() => {
      this.activeRuns.delete(runId);
    });
  }

  private waitForAnswers(
    runId: string,
    batch: UserQuestionBatch,
    signal: AbortSignal,
  ): Promise<UserQuestionBatch> {
    return new Promise((resolve, reject) => {
      const activeRun = this.activeRuns.get(runId);
      if (!activeRun) {
        reject(new Error("Run is not active."));
        return;
      }

      activeRun.pendingQuestionBatch = {
        batchId: batch.id,
        resolve,
        reject,
      };

      signal.addEventListener(
        "abort",
        () => {
          activeRun.pendingQuestionBatch?.reject(new Error("Run cancelled."));
          activeRun.pendingQuestionBatch = undefined;
        },
        { once: true },
      );
    });
  }

  async getPendingQuestionBatch(runId: string, batchId: string) {
    return getQuestionBatch(runId, batchId);
  }
}

declare global {
  var __multiAgentRunsManager: RunsManager | undefined;
}

export const runsManager = global.__multiAgentRunsManager ?? new RunsManager();

if (!global.__multiAgentRunsManager) {
  global.__multiAgentRunsManager = runsManager;
}
