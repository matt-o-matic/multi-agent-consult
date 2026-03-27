import "server-only";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  participants,
  refereeDecisions,
  runs,
  sourceRecords,
  toolInvocations,
  turns,
  userQuestionBatches,
} from "@/lib/db/schema";
import type {
  DebateTask,
  FinalConsensus,
  ParticipantConfig,
  RefereeDecision,
  RunConfig,
  RunDetail,
  RunStatus,
  RunSummary,
  SourceRecord,
  StopReason,
  ToolInvocationRecord,
  TurnRecord,
  UserQuestionBatch,
} from "@/lib/types";

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toParticipantConfig(row: typeof participants.$inferSelect): ParticipantConfig {
  return {
    role: row.role as ParticipantConfig["role"],
    modelId: row.modelId,
    provider: row.provider as ParticipantConfig["provider"],
    persona: row.persona ?? undefined,
    label: row.label,
  };
}

function toTurn(row: typeof turns.$inferSelect): TurnRecord {
  return {
    id: row.id,
    runId: row.runId,
    turnIndex: row.turnIndex,
    role: row.role as TurnRecord["role"],
    phase: row.phase as TurnRecord["phase"],
    modelId: row.modelId,
    content: row.content,
    summary: row.summary,
    latencyMs: row.latencyMs,
    tokenUsage: parseJson(row.usageJson, null),
    createdAt: row.createdAt,
  };
}

function toToolInvocation(
  row: typeof toolInvocations.$inferSelect,
): ToolInvocationRecord {
  return {
    id: row.id,
    runId: row.runId,
    turnId: row.turnId,
    role: row.role as ToolInvocationRecord["role"],
    toolName: row.toolName,
    status: row.status as ToolInvocationRecord["status"],
    inputJson: row.inputJson,
    outputJson: row.outputJson,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
  };
}

function toSourceRecord(row: typeof sourceRecords.$inferSelect): SourceRecord {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    domain: row.domain,
    snippet: row.snippet ?? undefined,
    sourceType: row.sourceType as SourceRecord["sourceType"],
    toolInvocationId: row.toolInvocationId ?? undefined,
    turnId: row.turnId ?? undefined,
    createdAt: row.createdAt,
  };
}

function toQuestionBatch(
  row: typeof userQuestionBatches.$inferSelect,
): UserQuestionBatch {
  return {
    id: row.id,
    runId: row.runId,
    status: row.status as UserQuestionBatch["status"],
    questions: parseJson(row.questionsJson, []),
    answers: parseJson(row.answersJson, null),
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
  };
}

function toRefereeDecision(
  row: typeof refereeDecisions.$inferSelect,
  batchLookup: Map<string, UserQuestionBatch>,
): RefereeDecision {
  return {
    id: row.id,
    runId: row.runId,
    turnIndex: row.turnIndex,
    converged: !!row.converged,
    confidence: row.confidence,
    summary: row.summary,
    preferredDraft: row.preferredDraft as RefereeDecision["preferredDraft"],
    requiredNextFocus: row.requiredNextFocus,
    remainingDisagreements: row.remainingDisagreements,
    needsUserInput: !!row.needsUserInput,
    questionBatch: row.questionBatchId
      ? batchLookup.get(row.questionBatchId) ?? null
      : null,
    createdAt: row.createdAt,
  };
}

function buildRunSummary(
  runRow: typeof runs.$inferSelect,
  participantRows: typeof participants.$inferSelect[],
): RunSummary {
  const participantMap = new Map(participantRows.map((row) => [row.role, row]));
  const participantA = participantMap.get("participant_a");
  const participantB = participantMap.get("participant_b");
  const referee = participantMap.get("referee");

  if (!participantA || !participantB || !referee) {
    throw new Error(`Run ${runRow.id} is missing required participants.`);
  }

  return {
    id: runRow.id,
    taskPrompt: runRow.taskPrompt,
    status: runRow.status as RunStatus,
    stopReason: (runRow.stopReason as StopReason | null) ?? null,
    createdAt: runRow.createdAt,
    updatedAt: runRow.updatedAt,
    participantA: toParticipantConfig(participantA),
    participantB: toParticipantConfig(participantB),
    referee: toParticipantConfig(referee),
  };
}

export async function hasActiveRun() {
  const [active] = await db
    .select({ count: sql<number>`count(*)` })
    .from(runs)
    .where(inArray(runs.status, ["queued", "running", "waiting_for_user"]));

  return active ? active.count > 0 : false;
}

export async function createRun(runId: string, config: RunConfig) {
  const now = new Date().toISOString();

  await db.insert(runs).values({
    id: runId,
    taskPrompt: config.taskPrompt,
    taskPlanJson: null,
    status: "queued",
    maxTurns: config.maxTurns,
    currentTurn: 0,
    currentTaskIndex: 0,
    searchBackend: config.searchBackend,
    workspaceMode: config.workspaceMode,
    workspacePath: config.workspacePath ?? null,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(participants).values(
    [config.participantA, config.participantB, config.referee].map((participant) => ({
      id: crypto.randomUUID(),
      runId,
      role: participant.role,
      modelId: participant.modelId,
      provider: participant.provider,
      persona: participant.persona ?? null,
      label: participant.label,
    })),
  );

  return getRunDetail(runId);
}

export async function listRunSummaries() {
  const runRows = await db.select().from(runs).orderBy(desc(runs.createdAt));
  if (runRows.length === 0) {
    return [] as RunSummary[];
  }

  const participantRows = await db
    .select()
    .from(participants)
    .where(
      inArray(
        participants.runId,
        runRows.map((row) => row.id),
      ),
    );

  return runRows.map((row) =>
    buildRunSummary(
      row,
      participantRows.filter((participant) => participant.runId === row.id),
    ),
  );
}

export async function getRunDetail(runId: string) {
  const [runRow] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!runRow) {
    return null;
  }

  const [
    participantRows,
    turnRows,
    toolRows,
    sourceRows,
    decisionRows,
    batchRows,
  ] = await Promise.all([
    db.select().from(participants).where(eq(participants.runId, runId)),
    db.select().from(turns).where(eq(turns.runId, runId)).orderBy(asc(turns.createdAt)),
    db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.runId, runId))
      .orderBy(asc(toolInvocations.createdAt)),
    db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.runId, runId))
      .orderBy(asc(sourceRecords.createdAt)),
    db
      .select()
      .from(refereeDecisions)
      .where(eq(refereeDecisions.runId, runId))
      .orderBy(asc(refereeDecisions.createdAt)),
    db
      .select()
      .from(userQuestionBatches)
      .where(eq(userQuestionBatches.runId, runId))
      .orderBy(asc(userQuestionBatches.createdAt)),
  ]);

  const summary = buildRunSummary(runRow, participantRows);
  const questionBatches = batchRows.map(toQuestionBatch);
  const questionBatchLookup = new Map(questionBatches.map((batch) => [batch.id, batch]));

  return {
    ...summary,
    maxTurns: runRow.maxTurns,
    searchBackend: runRow.searchBackend as RunDetail["searchBackend"],
    workspacePath: runRow.workspacePath,
    currentTurn: runRow.currentTurn,
    currentTaskIndex: runRow.currentTaskIndex,
    taskPlan: parseJson(runRow.taskPlanJson, [] as DebateTask[]),
    errorText: runRow.errorText,
    activeQuestionBatchId: runRow.activeQuestionBatchId,
    finalConsensus:
      runRow.finalSolution && runRow.finalRationale
        ? {
            solution: runRow.finalSolution,
            rationale: runRow.finalRationale,
            sources: parseJson(runRow.finalSourcesJson, []),
          }
        : null,
    turns: turnRows.map(toTurn),
    toolInvocations: toolRows.map(toToolInvocation),
    sources: sourceRows.map(toSourceRecord),
    refereeDecisions: decisionRows.map((row) =>
      toRefereeDecision(row, questionBatchLookup),
    ),
    questionBatches,
  } satisfies RunDetail;
}

export async function updateRunStatus(
  runId: string,
  status: RunStatus,
  options: {
    stopReason?: StopReason | null;
    errorText?: string | null;
    currentTurn?: number;
    currentTaskIndex?: number;
    activeQuestionBatchId?: string | null;
  } = {},
) {
  const now = new Date().toISOString();

  await db
    .update(runs)
    .set({
      status,
      stopReason: options.stopReason ?? undefined,
      errorText: options.errorText ?? undefined,
      currentTurn: options.currentTurn ?? undefined,
      currentTaskIndex: options.currentTaskIndex ?? undefined,
      activeQuestionBatchId: options.activeQuestionBatchId ?? undefined,
      updatedAt: now,
      completedAt:
        status === "completed" || status === "failed" || status === "cancelled"
          ? now
          : undefined,
    })
    .where(eq(runs.id, runId));
}

export async function deleteRunArtifactsForRetry(args: {
  batchIds?: string[];
  decisionIds?: string[];
  sourceIds?: string[];
  toolInvocationIds?: string[];
  turnIds?: string[];
}) {
  if (args.sourceIds && args.sourceIds.length > 0) {
    await db.delete(sourceRecords).where(inArray(sourceRecords.id, args.sourceIds));
  }

  if (args.toolInvocationIds && args.toolInvocationIds.length > 0) {
    await db
      .delete(toolInvocations)
      .where(inArray(toolInvocations.id, args.toolInvocationIds));
  }

  if (args.decisionIds && args.decisionIds.length > 0) {
    await db
      .delete(refereeDecisions)
      .where(inArray(refereeDecisions.id, args.decisionIds));
  }

  if (args.batchIds && args.batchIds.length > 0) {
    await db
      .delete(userQuestionBatches)
      .where(inArray(userQuestionBatches.id, args.batchIds));
  }

  if (args.turnIds && args.turnIds.length > 0) {
    await db.delete(turns).where(inArray(turns.id, args.turnIds));
  }
}

export async function prepareRunForRetry(
  runId: string,
  options: {
    activeQuestionBatchId?: string | null;
    currentTurn: number;
    currentTaskIndex?: number;
  },
) {
  const now = new Date().toISOString();

  await db
    .update(runs)
    .set({
      status: "queued",
      stopReason: null,
      errorText: null,
      currentTurn: options.currentTurn,
      currentTaskIndex: options.currentTaskIndex ?? 0,
      activeQuestionBatchId: options.activeQuestionBatchId ?? null,
      finalSolution: null,
      finalRationale: null,
      finalSourcesJson: null,
      updatedAt: now,
      completedAt: null,
    })
    .where(eq(runs.id, runId));
}

export async function recordTurn(turn: TurnRecord) {
  await db.insert(turns).values({
    id: turn.id,
    runId: turn.runId,
    turnIndex: turn.turnIndex,
    role: turn.role,
    phase: turn.phase,
    modelId: turn.modelId,
    content: turn.content,
    summary: turn.summary ?? null,
    latencyMs: turn.latencyMs ?? null,
    usageJson: turn.tokenUsage ? JSON.stringify(turn.tokenUsage) : null,
    createdAt: turn.createdAt,
  });
}

export async function recordToolInvocation(tool: ToolInvocationRecord) {
  await db.insert(toolInvocations).values({
    id: tool.id,
    runId: tool.runId,
    turnId: tool.turnId,
    role: tool.role,
    toolName: tool.toolName,
    status: tool.status,
    inputJson: tool.inputJson,
    outputJson: tool.outputJson ?? null,
    errorMessage: tool.errorMessage ?? null,
    createdAt: tool.createdAt,
  });
}

export async function recordSourceRecords(runId: string, sourcesToInsert: SourceRecord[]) {
  if (sourcesToInsert.length === 0) {
    return;
  }

  await db.insert(sourceRecords).values(
    sourcesToInsert.map((source) => ({
      id: source.id,
      runId,
      turnId: source.turnId ?? null,
      toolInvocationId: source.toolInvocationId ?? null,
      url: source.url,
      title: source.title,
      domain: source.domain,
      snippet: source.snippet ?? null,
      sourceType: source.sourceType,
      createdAt: source.createdAt,
    })),
  );
}

export async function recordRefereeDecision(decision: RefereeDecision) {
  await db.insert(refereeDecisions).values({
    id: decision.id,
    runId: decision.runId,
    turnIndex: decision.turnIndex,
    converged: decision.converged,
    confidence: decision.confidence,
    summary: decision.summary,
    preferredDraft: decision.preferredDraft,
    requiredNextFocus: decision.requiredNextFocus,
    remainingDisagreements: decision.remainingDisagreements,
    needsUserInput: decision.needsUserInput,
    questionBatchId: decision.questionBatch?.id ?? null,
    createdAt: decision.createdAt,
  });
}

export async function saveTaskPlan(runId: string, taskPlan: DebateTask[]) {
  const now = new Date().toISOString();

  await db
    .update(runs)
    .set({
      taskPlanJson: JSON.stringify(taskPlan),
      updatedAt: now,
    })
    .where(eq(runs.id, runId));
}

export async function saveQuestionBatch(batch: UserQuestionBatch) {
  await db.insert(userQuestionBatches).values({
    id: batch.id,
    runId: batch.runId,
    status: batch.status,
    questionsJson: JSON.stringify(batch.questions),
    answersJson: batch.answers ? JSON.stringify(batch.answers) : null,
    createdAt: batch.createdAt,
    answeredAt: batch.answeredAt ?? null,
  });

  await updateRunStatus(batch.runId, "waiting_for_user", {
    activeQuestionBatchId: batch.id,
  });
}

export async function answerQuestionBatch(
  runId: string,
  batchId: string,
  answers: UserQuestionBatch["answers"],
) {
  const now = new Date().toISOString();
  await db
    .update(userQuestionBatches)
    .set({
      status: "answered",
      answersJson: JSON.stringify(answers),
      answeredAt: now,
    })
    .where(
      and(eq(userQuestionBatches.id, batchId), eq(userQuestionBatches.runId, runId)),
    );

  await updateRunStatus(runId, "running", {
    activeQuestionBatchId: null,
  });

  return getQuestionBatch(runId, batchId);
}

export async function getQuestionBatch(runId: string, batchId: string) {
  const [row] = await db
    .select()
    .from(userQuestionBatches)
    .where(
      and(eq(userQuestionBatches.runId, runId), eq(userQuestionBatches.id, batchId)),
    );

  return row ? toQuestionBatch(row) : null;
}

export async function saveFinalConsensus(
  runId: string,
  finalConsensus: FinalConsensus,
  stopReason: StopReason,
) {
  const now = new Date().toISOString();

  await db
    .update(runs)
    .set({
      status: "completed",
      stopReason,
      finalSolution: finalConsensus.solution,
      finalRationale: finalConsensus.rationale,
      finalSourcesJson: JSON.stringify(finalConsensus.sources),
      updatedAt: now,
      completedAt: now,
    })
    .where(eq(runs.id, runId));
}
