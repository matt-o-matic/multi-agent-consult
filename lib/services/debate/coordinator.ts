import "server-only";

import { z } from "zod";

import {
  getDebateRoleLabel,
  getOtherParticipantRole,
  normalizeDebateMode,
} from "@/lib/debate-mode";
import {
  recordRefereeDecision,
  recordSourceRecords,
  recordToolInvocation,
  recordTurn,
  saveFinalConsensus,
  saveQuestionBatch,
  saveTaskPlan,
  updateRunStatus,
} from "@/lib/data/run-store";
import type {
  ProviderMessage,
} from "@/lib/providers/base";
import type { ProviderAdapter } from "@/lib/providers/base";
import {
  buildParticipantCritiqueUserPrompt,
  buildParticipantSystemPrompt,
  buildParticipantUserPrompt,
  buildRefereeSystemPrompt,
  buildRefereeUserPrompt,
  buildTaskPlanSystemPrompt,
  buildTaskPlanUserPrompt,
} from "@/lib/services/debate/prompts";
import {
  executeChatWithRetry,
  RetryableStructuredOutputError,
} from "@/lib/services/chat-retry";
import { runEventBus } from "@/lib/services/event-bus";
import { runLiveStateStore } from "@/lib/services/live-state";
import {
  executeTool,
  participantToolDefinitions,
} from "@/lib/services/tool-broker";
import type {
  ActorRole,
  DebateMode,
  DebateTask,
  EvidencePacket,
  FinalConsensus,
  ParticipantRole,
  RefereeDecision,
  RunConfig,
  RunDetail,
  RunEvent,
  SourceRecord,
  ToolInvocationRecord,
  TurnPhase,
  TurnRecord,
  UserQuestionBatch,
  UserQuestionProposal,
  WorkspaceManifest,
} from "@/lib/types";

const questionOptionPayloadSchema = z.union([
  z.string().trim().min(1),
  z
    .object({
      id: z.string().trim().min(1).optional(),
      label: z.string().trim().min(1).optional(),
      description: z.string().trim().min(1).optional(),
      recommended: z.boolean().optional(),
    })
    .refine(
      (value) =>
        Boolean(value.id?.trim() || value.label?.trim() || value.description?.trim()),
      {
        message:
          "Question option objects must include at least one of id, label, or description.",
      },
    ),
]);

function normalizeQuestionPromptText(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return undefined;
}

function normalizeQuestionPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  return {
    ...record,
    question:
      normalizeQuestionPromptText(record.question) ??
      normalizeQuestionPromptText(record.prompt) ??
      normalizeQuestionPromptText(record.title) ??
      normalizeQuestionPromptText(record.header) ??
      normalizeQuestionPromptText(record.text),
  };
}

const questionPayloadSchema = z.preprocess(
  normalizeQuestionPayload,
  z.object({
    id: z.string().trim().min(1).optional(),
    question: z.string().trim().min(1),
    notePlaceholder: z.string().trim().min(1).optional(),
    options: z.array(questionOptionPayloadSchema).min(2),
  }),
);

const questionBatchPayloadSchema = z.object({
  questions: z.array(questionPayloadSchema).min(1),
});

const taskDefinitionSchema = z.object({
  title: z.string().min(1),
  objective: z.string().min(1),
  completionCriteria: z.string().min(1),
});

const planningResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("tasks"),
    tasks: z.array(taskDefinitionSchema).min(1).max(5),
  }),
  z.object({
    outcome: z.literal("question_batch"),
    summary: z.string().min(1),
    questionBatch: questionBatchPayloadSchema,
  }),
]);

const refereeDecisionSchema = z.object({
  converged: z.boolean(),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  preferredDraft: z.enum(["participant_a", "participant_b", "tie"]),
  requiredNextFocus: z.string().min(1),
  remainingDisagreements: z.string().min(1),
  blockingIssues: z.array(z.string().min(1)).optional(),
  carryForwardNotes: z.array(z.string().min(1)).optional(),
  diminishingReturns: z.array(z.string().min(1)).optional(),
  needsUserInput: z.boolean(),
  questionBatch: questionBatchPayloadSchema.optional(),
});

interface ParticipantTurnResult {
  evidencePacket?: EvidencePacket | null;
  turn: TurnRecord;
  toolInvocations: ToolInvocationRecord[];
  sources: SourceRecord[];
  questionProposals: UserQuestionProposal[];
}

type ParticipantResultMap = Partial<Record<ParticipantRole, ParticipantTurnResult>>;

interface RunCheckpoint {
  taskPlan: DebateTask[];
  currentTaskIndex: number;
  currentMilestoneTurn: number;
  answeredQuestionBatches: UserQuestionBatch[];
  carryForwardNotes: string[];
  collectedSources: SourceRecord[];
  latestDrafts: ParticipantResultMap;
  latestCritiques: ParticipantResultMap;
  previousDecision: RefereeDecision | null;
  startTurnIndex: number;
}

interface ExecuteRunArgs {
  runId: string;
  config: RunConfig;
  workspaceManifest?: WorkspaceManifest | null;
  signal: AbortSignal;
  waitForAnswers: (batch: UserQuestionBatch, signal: AbortSignal) => Promise<UserQuestionBatch>;
}

interface DebateModeDefinition {
  critiqueRoles: ParticipantRole[];
  draftRoles: ParticipantRole[];
  finalDraftRoles: ParticipantRole[];
  id: DebateMode;
  parallelCritiques: boolean;
  parallelDrafts: boolean;
}

const PARTICIPANT_MAX_TOOL_EXCHANGES = 64;

const debateModeRegistry: Record<DebateMode, DebateModeDefinition> = {
  collaborative_debate: {
    critiqueRoles: ["participant_a", "participant_b"],
    draftRoles: ["participant_a", "participant_b"],
    finalDraftRoles: ["participant_a", "participant_b"],
    id: "collaborative_debate",
    parallelCritiques: true,
    parallelDrafts: true,
  },
  writers_room: {
    critiqueRoles: ["participant_b"],
    draftRoles: ["participant_a"],
    finalDraftRoles: ["participant_a"],
    id: "writers_room",
    parallelCritiques: false,
    parallelDrafts: false,
  },
};

function getModeDefinition(mode?: DebateMode | null) {
  return debateModeRegistry[normalizeDebateMode(mode)];
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

function publishTurnStarted(args: {
  attempt: number;
  maxAttempts: number;
  modelId: string;
  phase: TurnPhase;
  role: ActorRole;
  runId: string;
  turnIndex: number;
}) {
  publish(args.runId, {
    type: "turn_started",
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    role: args.role,
    phase: args.phase,
    turnIndex: args.turnIndex,
    modelId: args.modelId,
    at: isoNow(),
  });
}

function publishTurnDelta(args: {
  attempt: number;
  runId: string;
  maxAttempts: number;
  role: ActorRole;
  phase: TurnPhase;
  turnIndex: number;
  modelId: string;
  delta: string;
  content: string;
}) {
  publish(args.runId, {
    type: "turn_delta",
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    role: args.role,
    phase: args.phase,
    turnIndex: args.turnIndex,
    modelId: args.modelId,
    delta: args.delta,
    content: args.content,
    at: isoNow(),
  });
}

function publishTurnRetrying(args: {
  attempt: number;
  lastError: string;
  maxAttempts: number;
  modelId: string;
  phase: TurnPhase;
  retryDelayMs: number;
  role: ActorRole;
  runId: string;
  turnIndex: number;
}) {
  publish(args.runId, {
    type: "turn_retrying",
    attempt: args.attempt,
    lastError: args.lastError,
    maxAttempts: args.maxAttempts,
    modelId: args.modelId,
    phase: args.phase,
    retryDelayMs: args.retryDelayMs,
    role: args.role,
    turnIndex: args.turnIndex,
    at: isoNow(),
  });
}

function formatStructuredOutputError(error: unknown) {
  if (error instanceof z.ZodError) {
    return error.issues
      .slice(0, 3)
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "root";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
  }

  return error instanceof Error ? error.message : "The model returned invalid structured output.";
}

function limitRepairOutput(value: string, maxLength = 4_000) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
}

function buildStructuredRepairMessages(args: {
  invalidOutput: string;
  messages: ProviderMessage[];
  validationError: string;
}) {
  return [
    ...args.messages,
    {
      role: "assistant" as const,
      content: limitRepairOutput(args.invalidOutput) || "(empty response)",
    },
    {
      role: "user" as const,
      content: [
        "Your previous response could not be parsed as valid JSON for this step.",
        `Validation problem: ${args.validationError}`,
        "Return corrected JSON only.",
        "Do not include markdown fences, commentary, or any prose outside the JSON object.",
      ].join("\n"),
    },
  ];
}

function buildRetryStatusMessage(args: {
  attempt: number;
  label: string;
  lastError: string;
  maxAttempts: number;
  retryDelayMs: number;
}) {
  const delaySeconds = Math.max(0, Math.ceil(args.retryDelayMs / 1000));
  const retryDelayLabel =
    delaySeconds > 0 ? ` in ${delaySeconds}s` : "";

  return `${args.label} attempt ${args.attempt - 1} failed: ${args.lastError} Retrying attempt ${args.attempt} of ${args.maxAttempts}${retryDelayLabel}.`;
}

function formatPhaseName(phase: TurnPhase) {
  switch (phase) {
    case "referee":
      return "evaluation";
    case "planning":
    case "proposal":
    case "revision":
    case "critique":
    case "final":
      return phase;
    default:
      return phase;
  }
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

function dedupeEvidencePackets(
  packets: Array<EvidencePacket | null | undefined>,
): EvidencePacket[] {
  const seen = new Set<string>();
  const unique: EvidencePacket[] = [];

  for (const packet of packets) {
    if (!packet) {
      continue;
    }

    const key = `${packet.gatheredBy}:${packet.turnId}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(packet);
  }

  return unique;
}

function toParticipantTurnResult(turn: TurnRecord): ParticipantTurnResult {
  return {
    evidencePacket: null,
    turn,
    toolInvocations: [],
    sources: [],
    questionProposals: [],
  };
}

function truncateEvidenceText(value: string, maxLength = 280) {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

function parseJsonValue(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function collectEvidenceNotes(value: unknown, notes: string[], depth = 0) {
  if (notes.length >= 6 || depth > 2 || value == null) {
    return;
  }

  if (typeof value === "string") {
    const text = truncateEvidenceText(value);
    if (text.length > 0 && !notes.includes(text)) {
      notes.push(text);
    }
    return;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 5)) {
      collectEvidenceNotes(entry, notes, depth + 1);
      if (notes.length >= 6) {
        return;
      }
    }
    return;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferredKeys = ["summary", "snippet", "content", "title", "result", "results", "matches"];
    for (const key of preferredKeys) {
      if (key in record) {
        collectEvidenceNotes(record[key], notes, depth + 1);
        if (notes.length >= 6) {
          return;
        }
      }
    }

    for (const [key, entry] of Object.entries(record)) {
      if (
        preferredKeys.includes(key) ||
        key === "url" ||
        key === "id" ||
        key === "recommended" ||
        key === "description" ||
        key === "label"
      ) {
        continue;
      }

      collectEvidenceNotes(entry, notes, depth + 1);
      if (notes.length >= 6) {
        return;
      }
    }
  }
}

function buildEvidencePacket(args: {
  role: ParticipantRole;
  turn: TurnRecord;
  toolInvocations: ToolInvocationRecord[];
  sources: SourceRecord[];
}): EvidencePacket | null {
  const relevantTools = args.toolInvocations.filter(
    (tool) => tool.status === "success" && tool.toolName !== "propose_user_questions",
  );
  const relevantSources = dedupeSources(args.sources);

  if (relevantTools.length === 0 && relevantSources.length === 0) {
    return null;
  }

  const notes: string[] = [];
  for (const tool of relevantTools) {
    collectEvidenceNotes(parseJsonValue(tool.outputJson), notes);
    if (notes.length >= 6) {
      break;
    }
  }

  const toolNameByInvocationId = new Map(
    relevantTools.map((tool) => [tool.id, tool.toolName] as const),
  );

  return {
    gatheredBy: args.role,
    turnId: args.turn.id,
    turnIndex: args.turn.turnIndex,
    phase: args.turn.phase,
    toolNames: [...new Set(relevantTools.map((tool) => tool.toolName))],
    extractedNotes: notes,
    items: relevantSources.map((source) => ({
      title: source.title,
      domain: source.domain,
      url: source.url,
      snippet: source.snippet,
      toolName: source.toolInvocationId
        ? toolNameByInvocationId.get(source.toolInvocationId)
        : undefined,
    })),
  };
}

function buildTurnArtifactsByTurnId<T extends { turnId: string }>(items: T[]) {
  const map = new Map<string, T[]>();

  for (const item of items) {
    const existing = map.get(item.turnId) ?? [];
    existing.push(item);
    map.set(item.turnId, existing);
  }

  return map;
}

function createQuestionBatch(
  runId: string,
  payload: z.infer<typeof questionBatchPayloadSchema> | undefined,
) {
  if (!payload) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    runId,
    status: "pending" as const,
    questions: payload.questions.map((question) => ({
      id: question.id ?? crypto.randomUUID(),
      question: question.question,
      notePlaceholder:
        question.notePlaceholder ??
        "Add optional context or constraints for this answer.",
      options: normalizeQuestionOptions(question.options),
    })),
    answers: null,
    createdAt: isoNow(),
    answeredAt: null,
  };
}

function slugifyQuestionOptionId(value: string, fallback: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function normalizeQuestionOption(
  option: z.infer<typeof questionOptionPayloadSchema>,
  index: number,
) {
  if (typeof option === "string") {
    const label = option.trim();
    return {
      id: slugifyQuestionOptionId(label, `option-${index + 1}`),
      label,
      description: label,
      recommended: false,
    };
  }

  const label =
    option.label?.trim() || option.description?.trim() || option.id?.trim() || `Option ${index + 1}`;
  const description = option.description?.trim() || label;

  return {
    id: slugifyQuestionOptionId(option.id?.trim() || label, `option-${index + 1}`),
    label,
    description,
    recommended: option.recommended ?? false,
  };
}

function normalizeQuestionOptions(
  options: Array<z.infer<typeof questionOptionPayloadSchema>>,
) {
  const usedIds = new Set<string>();

  return options.map((option, index) => {
    const normalized = normalizeQuestionOption(option, index);
    let uniqueId = normalized.id;
    let suffix = 2;

    while (usedIds.has(uniqueId)) {
      uniqueId = `${normalized.id}-${suffix}`;
      suffix += 1;
    }

    usedIds.add(uniqueId);

    return {
      ...normalized,
      id: uniqueId,
    };
  });
}

function toTaskPlan(tasks: Array<z.infer<typeof taskDefinitionSchema>>) {
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

function buildSelectionRationale(args: {
  finalDecision: RefereeDecision;
  selectedTurn: TurnRecord;
  taskPlan: DebateTask[];
  usedTieFallback?: boolean;
}) {
  const completedTasks = args.taskPlan
    .map((task, index) => `${index + 1}. ${task.title}`)
    .join("\n");

  return [
    `Selected final draft: ${args.selectedTurn.role} (${args.selectedTurn.modelId}).`,
    args.usedTieFallback
      ? "The referee left the final preference unresolved, so the coordinator used the canonical participant draft for this mode."
      : null,
    "",
    `Referee summary: ${args.finalDecision.summary}`,
    "",
    `Completed milestone path:\n${completedTasks}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function latestTurnByPhases(
  turns: TurnRecord[],
  role: ParticipantRole,
  phases: TurnPhase[],
) {
  return [...turns]
    .filter((turn) => turn.role === role && phases.includes(turn.phase))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1) ?? null;
}

function assertCompletedCycle(args: {
  debateMode: DebateMode;
  currentTaskIndex: number;
  finalDecision: RefereeDecision | null;
  latestCritiques: ParticipantResultMap;
  latestDrafts: ParticipantResultMap;
  taskPlan: DebateTask[];
}) {
  const mode = getModeDefinition(args.debateMode);
  assertMilestonePlan(args.taskPlan);

  if (!getCurrentTask(args.taskPlan, args.currentTaskIndex)) {
    throw new Error("No current milestone is available for finalization.");
  }

  if (!args.finalDecision) {
    throw new Error("A referee decision is required before finalization.");
  }

  for (const role of mode.draftRoles) {
    const turn = args.latestDrafts[role]?.turn ?? null;
    if (!turn || !["proposal", "revision"].includes(turn.phase)) {
      throw new Error(
        `${getDebateRoleLabel(mode.id, role)} is missing the completed draft or revision output for finalization.`,
      );
    }
    if (turn.turnIndex !== args.finalDecision.turnIndex) {
      throw new Error("Finalization requires participant draft outputs from the same completed cycle as the referee decision.");
    }
  }

  for (const role of mode.critiqueRoles) {
    const turn = args.latestCritiques[role]?.turn ?? null;
    if (!turn || turn.phase !== "critique") {
      throw new Error(
        `${getDebateRoleLabel(mode.id, role)} is missing the completed critique output for finalization.`,
      );
    }
    if (turn.turnIndex !== args.finalDecision.turnIndex) {
      throw new Error("Finalization requires critique outputs from the same completed cycle as the referee decision.");
    }
  }
}

function assertFinalMilestoneForFinalization(
  taskPlan: DebateTask[],
  currentTaskIndex: number,
) {
  assertMilestonePlan(taskPlan);

  const finalTaskIndex = taskPlan.length - 1;
  if (currentTaskIndex < 0 || currentTaskIndex > finalTaskIndex) {
    throw new Error("No current milestone is available for finalization.");
  }

  if (currentTaskIndex !== finalTaskIndex) {
    throw new Error(
      `Cannot finalize before the final milestone. Current milestone ${currentTaskIndex + 1} of ${taskPlan.length}.`,
    );
  }
}

function selectFinalTurn(args: {
  debateMode: DebateMode;
  finalDecision: RefereeDecision;
  latestDrafts: ParticipantResultMap;
}) {
  const mode = getModeDefinition(args.debateMode);
  const draftA = args.latestDrafts.participant_a?.turn ?? null;
  const draftB = args.latestDrafts.participant_b?.turn ?? null;

  if (!draftA) {
    throw new Error("Participant A draft is required for final selection.");
  }

  if (mode.id === "writers_room") {
    if (args.finalDecision.preferredDraft === "participant_b") {
      throw new Error("The editor cannot be selected as the final draft author in writer's room mode.");
    }

    return {
      selectedTurn: draftA,
      usedTieFallback: args.finalDecision.preferredDraft !== "participant_a",
    };
  }

  if (!draftB) {
    throw new Error("Participant B draft is required for collaborative final selection.");
  }

  if (args.finalDecision.preferredDraft === "participant_b") {
    return {
      selectedTurn: draftB,
      usedTieFallback: false,
    };
  }

  if (args.finalDecision.preferredDraft === "participant_a") {
    return {
      selectedTurn: draftA,
      usedTieFallback: false,
    };
  }

  return {
    selectedTurn: draftA,
    usedTieFallback: true,
  };
}

function buildCycleLabel(currentMilestoneTurn: number, maxTurns: number) {
  return `Cycle ${currentMilestoneTurn + 1} of ${maxTurns}`;
}

function buildDraftStatusMessage(
  mode: DebateMode,
  currentTaskIndex: number,
  currentMilestoneTurn: number,
  maxTurns: number,
  task: DebateTask,
) {
  if (getModeDefinition(mode).id === "writers_room") {
    return `Writer is drafting milestone ${currentTaskIndex + 1}: ${task.title}. ${buildCycleLabel(currentMilestoneTurn, maxTurns)}.`;
  }

  return `Participants are drafting milestone ${currentTaskIndex + 1}: ${task.title}. ${buildCycleLabel(currentMilestoneTurn, maxTurns)}.`;
}

function buildCritiqueStatusMessage(
  mode: DebateMode,
  currentTaskIndex: number,
  currentMilestoneTurn: number,
  maxTurns: number,
  task: DebateTask,
) {
  if (getModeDefinition(mode).id === "writers_room") {
    return `Editor is critiquing milestone ${currentTaskIndex + 1}: ${task.title}. ${buildCycleLabel(currentMilestoneTurn, maxTurns)}.`;
  }

  return `Participants are critiquing each other's milestone ${currentTaskIndex + 1} outputs. ${buildCycleLabel(currentMilestoneTurn, maxTurns)}.`;
}

function getParticipantConfig(config: RunConfig, role: ParticipantRole) {
  return role === "participant_a" ? config.participantA : config.participantB;
}

function validateRefereeDecisionForMode(
  mode: DebateMode,
  decision: z.infer<typeof refereeDecisionSchema>,
) {
  if (decision.needsUserInput && !decision.questionBatch) {
    throw new Error("The referee requested user input without returning a question batch.");
  }

  if (decision.needsUserInput && decision.converged) {
    throw new Error("The referee cannot request user input and mark the milestone converged in the same decision.");
  }

  if (getModeDefinition(mode).id === "writers_room" && decision.preferredDraft === "participant_b") {
    throw new Error("The editor cannot be preferred as the final draft author in writer's room mode.");
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
        currentMilestoneTurn: 0,
        answeredQuestionBatches: [],
        carryForwardNotes: [],
        collectedSources: [],
        latestDrafts: {},
        latestCritiques: {},
        previousDecision: null,
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
    if (!hasPlanningTurn(args.run.turns)) {
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
    const currentMilestoneStartTurn = Math.max(0, run.currentTurn - run.currentMilestoneTurn);
    const relevantTurns = [...run.turns]
      .filter((turn) => turn.turnIndex >= currentMilestoneStartTurn)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const toolsByTurnId = buildTurnArtifactsByTurnId(run.toolInvocations);
    const sourcesByTurnId = buildTurnArtifactsByTurnId(
      run.sources.filter(
        (source): source is SourceRecord & { turnId: string } => typeof source.turnId === "string",
      ),
    );
    const latestDraftATurn = options.carryForwardDecision
      ? latestTurnByPhases(relevantTurns, "participant_a", ["proposal", "revision"])
      : null;
    const latestDraftBTurn = options.carryForwardDecision
      ? latestTurnByPhases(relevantTurns, "participant_b", ["proposal", "revision"])
      : null;
    const latestCritiqueATurn = options.carryForwardDecision
      ? latestTurnByPhases(relevantTurns, "participant_a", ["critique"])
      : null;
    const latestCritiqueBTurn = options.carryForwardDecision
      ? latestTurnByPhases(relevantTurns, "participant_b", ["critique"])
      : null;
    const previousMilestoneDecision =
      run.currentTaskIndex > 0
        ? run.refereeDecisions.find(
            (decision) => decision.turnIndex === currentMilestoneStartTurn - 1,
          ) ?? null
        : null;

    return {
      taskPlan: [...run.taskPlan],
      currentTaskIndex: run.currentTaskIndex,
      currentMilestoneTurn: run.currentMilestoneTurn,
      answeredQuestionBatches: run.questionBatches.filter(
        (batch) => batch.status === "answered" || batch.status === "skipped",
      ),
      carryForwardNotes: previousMilestoneDecision?.carryForwardNotes ?? [],
      collectedSources: [...run.sources],
      latestDrafts: options.carryForwardDecision
        ? {
            participant_a: latestDraftATurn
              ? {
                  ...toParticipantTurnResult(latestDraftATurn),
                  toolInvocations: toolsByTurnId.get(latestDraftATurn.id) ?? [],
                  sources: sourcesByTurnId.get(latestDraftATurn.id) ?? [],
                  evidencePacket: buildEvidencePacket({
                    role: "participant_a",
                    turn: latestDraftATurn,
                    toolInvocations: toolsByTurnId.get(latestDraftATurn.id) ?? [],
                    sources: sourcesByTurnId.get(latestDraftATurn.id) ?? [],
                  }),
                }
              : undefined,
            participant_b: latestDraftBTurn
              ? {
                  ...toParticipantTurnResult(latestDraftBTurn),
                  toolInvocations: toolsByTurnId.get(latestDraftBTurn.id) ?? [],
                  sources: sourcesByTurnId.get(latestDraftBTurn.id) ?? [],
                  evidencePacket: buildEvidencePacket({
                    role: "participant_b",
                    turn: latestDraftBTurn,
                    toolInvocations: toolsByTurnId.get(latestDraftBTurn.id) ?? [],
                    sources: sourcesByTurnId.get(latestDraftBTurn.id) ?? [],
                  }),
                }
              : undefined,
          }
        : {},
      latestCritiques: options.carryForwardDecision
        ? {
            participant_a: latestCritiqueATurn
              ? {
                  ...toParticipantTurnResult(latestCritiqueATurn),
                  toolInvocations: toolsByTurnId.get(latestCritiqueATurn.id) ?? [],
                  sources: sourcesByTurnId.get(latestCritiqueATurn.id) ?? [],
                  evidencePacket: buildEvidencePacket({
                    role: "participant_a",
                    turn: latestCritiqueATurn,
                    toolInvocations: toolsByTurnId.get(latestCritiqueATurn.id) ?? [],
                    sources: sourcesByTurnId.get(latestCritiqueATurn.id) ?? [],
                  }),
                }
              : undefined,
            participant_b: latestCritiqueBTurn
              ? {
                  ...toParticipantTurnResult(latestCritiqueBTurn),
                  toolInvocations: toolsByTurnId.get(latestCritiqueBTurn.id) ?? [],
                  sources: sourcesByTurnId.get(latestCritiqueBTurn.id) ?? [],
                  evidencePacket: buildEvidencePacket({
                    role: "participant_b",
                    turn: latestCritiqueBTurn,
                    toolInvocations: toolsByTurnId.get(latestCritiqueBTurn.id) ?? [],
                    sources: sourcesByTurnId.get(latestCritiqueBTurn.id) ?? [],
                  }),
                }
              : undefined,
          }
        : {},
      previousDecision:
        options.carryForwardDecision ? (run.refereeDecisions.at(-1) ?? null) : null,
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
    const debateMode = normalizeDebateMode(config.debateMode);
    let currentTaskIndex = checkpoint.currentTaskIndex;
    let currentMilestoneTurn = checkpoint.currentMilestoneTurn;
    const answeredQuestionBatches = [...checkpoint.answeredQuestionBatches];
    let carryForwardNotes = [...checkpoint.carryForwardNotes];
    let taskPlan = [...checkpoint.taskPlan];
    let previousDecision: RefereeDecision | null = checkpoint.previousDecision;
    const collectedSources = [...checkpoint.collectedSources];
    let latestDrafts: ParticipantResultMap = { ...checkpoint.latestDrafts };
    let latestCritiques: ParticipantResultMap = { ...checkpoint.latestCritiques };

    await updateRunStatus(runId, "running", {
      currentTurn: checkpoint.startTurnIndex,
      currentMilestoneTurn,
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
      if (taskPlan.length === 0) {
        taskPlan = await this.resolveTaskPlan({
          runId,
          config: {
            ...config,
            debateMode,
          },
          answeredQuestionBatches,
          signal,
          waitForAnswers,
        });
      }
      assertMilestonePlan(taskPlan);

      if (options.finalizationOnly) {
        assertCompletedCycle({
          debateMode,
          currentTaskIndex,
          finalDecision: previousDecision,
          latestCritiques,
          latestDrafts,
          taskPlan,
        });

        const stopReason = previousDecision?.converged ? "converged" : "max_turns";
        await this.completeRunFromCurrentCycle({
          runId,
          debateMode,
          finalDecision: previousDecision!,
          latestDrafts,
          taskPlan,
          currentTaskIndex,
          sources: dedupeSources(collectedSources),
          stopReason,
        });
        return;
      }

      const totalCycleBudget = taskPlan.length * config.maxTurns;

      for (
        let turnIndex = checkpoint.startTurnIndex;
        turnIndex < totalCycleBudget;
        turnIndex += 1
      ) {
        assertNotAborted(signal);
        const currentTask = getCurrentTask(taskPlan, currentTaskIndex);
        if (!currentTask) {
          throw new Error("The task plan has no current milestone.");
        }

        await this.persistRunCursor({
          runId,
          currentTurn: turnIndex,
          currentMilestoneTurn,
          currentTaskIndex,
        });
        publish(runId, {
          type: "status",
          status: "running",
          message: buildDraftStatusMessage(
            debateMode,
            currentTaskIndex,
            currentMilestoneTurn,
            config.maxTurns,
            currentTask,
          ),
          at: isoNow(),
        });

        const draftResults = await this.executeParticipantPhaseSet({
          runId,
          config: {
            ...config,
            debateMode,
          },
          currentTaskIndex,
          debateMode,
          latestCritiques,
          latestDrafts,
          phase: previousDecision ? "revision" : "proposal",
          roles: getModeDefinition(debateMode).draftRoles,
          signal,
          taskPlan,
          turnIndex,
          workspaceManifest,
          answeredQuestionBatches,
          parallel: getModeDefinition(debateMode).parallelDrafts,
          currentMilestoneTurn,
          maxMilestoneTurns: config.maxTurns,
          carryForwardNotes,
          previousDecision,
        });
        latestDrafts = {
          ...latestDrafts,
          ...draftResults,
        };
        for (const result of Object.values(draftResults)) {
          if (result) {
            collectedSources.push(...result.sources);
          }
        }

        publish(runId, {
          type: "status",
          status: "running",
          message: buildCritiqueStatusMessage(
            debateMode,
            currentTaskIndex,
            currentMilestoneTurn,
            config.maxTurns,
            currentTask,
          ),
          at: isoNow(),
        });

        const critiqueResults = await this.executeParticipantPhaseSet({
          runId,
          config: {
            ...config,
            debateMode,
          },
          currentTaskIndex,
          debateMode,
          latestCritiques,
          latestDrafts,
          phase: "critique",
          roles: getModeDefinition(debateMode).critiqueRoles,
          signal,
          taskPlan,
          turnIndex,
          workspaceManifest,
          answeredQuestionBatches,
          parallel: getModeDefinition(debateMode).parallelCritiques,
          currentMilestoneTurn,
          maxMilestoneTurns: config.maxTurns,
          carryForwardNotes,
          previousDecision,
        });
        latestCritiques = {
          ...latestCritiques,
          ...critiqueResults,
        };
        for (const result of Object.values(critiqueResults)) {
          if (result) {
            collectedSources.push(...result.sources);
          }
        }

        publish(runId, {
          type: "status",
          status: "running",
          message: `Referee is evaluating milestone ${currentTaskIndex + 1}: ${currentTask.title}.`,
          at: isoNow(),
        });

        const refereeResult = await this.executeRefereeTurn({
          runId,
          config: {
            ...config,
            debateMode,
          },
          currentTaskIndex,
          debateMode,
          latestCritiques,
          latestDrafts,
          previousDecision,
          currentMilestoneTurn,
          maxMilestoneTurns: config.maxTurns,
          carryForwardNotes,
          answeredQuestionBatches,
          questionProposals: {
            participant_a: [
              ...(draftResults.participant_a?.questionProposals ?? []),
              ...(critiqueResults.participant_a?.questionProposals ?? []),
            ],
            participant_b: [
              ...(draftResults.participant_b?.questionProposals ?? []),
              ...(critiqueResults.participant_b?.questionProposals ?? []),
            ],
          },
          signal,
          taskPlan,
          turnIndex,
        });
        previousDecision = refereeResult.decision;
        const isFinalTask = currentTaskIndex >= taskPlan.length - 1;
        const milestoneBudgetRemaining = currentMilestoneTurn < config.maxTurns - 1;
        const nextTurnIndex = turnIndex + 1;

        if (refereeResult.decision.questionBatch) {
          await saveQuestionBatch(refereeResult.decision.questionBatch);
          publish(runId, {
            type: "question_batch",
            batch: refereeResult.decision.questionBatch,
            at: isoNow(),
          });

          const answeredBatch = await waitForAnswers(refereeResult.decision.questionBatch, signal);
          answeredQuestionBatches.push(answeredBatch);
          publish(runId, {
            type: "question_batch_answered",
            batch: answeredBatch,
            at: isoNow(),
          });
          publish(runId, {
            type: "status",
            status: "running",
            message: milestoneBudgetRemaining
              ? "Clarifications received. Re-running the current milestone with the new answers."
              : isFinalTask
                ? "Clarifications received after the final milestone hit its cycle cap. Finalizing from the latest completed cycle."
                : "Clarifications received after this milestone hit its cycle cap. Advancing with carry-forward notes.",
            at: isoNow(),
          });
          if (milestoneBudgetRemaining) {
            currentMilestoneTurn += 1;
            await this.persistRunCursor({
              runId,
              currentTurn: nextTurnIndex,
              currentMilestoneTurn,
              currentTaskIndex,
            });
            continue;
          }

          if (!isFinalTask) {
            const completedTaskTitle = currentTask.title;
            currentTaskIndex += 1;
            currentMilestoneTurn = 0;
            carryForwardNotes = refereeResult.decision.carryForwardNotes ?? [];
            previousDecision = null;
            latestDrafts = {};
            latestCritiques = {};
            await this.persistRunCursor({
              runId,
              currentTurn: nextTurnIndex,
              currentMilestoneTurn,
              currentTaskIndex,
            });
            const nextTask = getCurrentTask(taskPlan, currentTaskIndex);
            publish(runId, {
              type: "status",
              status: "running",
              message: nextTask
                ? `Milestone "${completedTaskTitle}" reached its cycle cap after clarification. Advancing to ${nextTask.title}.`
                : `Milestone "${completedTaskTitle}" reached its cycle cap after clarification. Advancing to the next step.`,
              at: isoNow(),
            });
            continue;
          }

          assertCompletedCycle({
            debateMode,
            currentTaskIndex,
            finalDecision: refereeResult.decision,
            latestCritiques,
            latestDrafts,
            taskPlan,
          });
          await this.completeRunFromCurrentCycle({
            runId,
            debateMode,
            finalDecision: refereeResult.decision,
            latestDrafts,
            taskPlan,
            currentTaskIndex,
            sources: dedupeSources(collectedSources),
            stopReason: "max_turns",
          });
          return;
        }

        if (
          refereeResult.decision.converged &&
          isFinalTask &&
          decisionRequestsAnotherPass(refereeResult.decision) &&
          milestoneBudgetRemaining
        ) {
          currentMilestoneTurn += 1;
          await this.persistRunCursor({
            runId,
            currentTurn: nextTurnIndex,
            currentMilestoneTurn,
            currentTaskIndex,
          });
          publish(runId, {
            type: "status",
            status: "running",
            message:
              "Referee marked the final milestone converged but still asked for another pass. Continuing debate.",
            at: isoNow(),
          });
          continue;
        }

        if (refereeResult.decision.converged && !isFinalTask) {
          const completedTaskTitle = currentTask.title;
          currentTaskIndex += 1;
          currentMilestoneTurn = 0;
          carryForwardNotes = refereeResult.decision.carryForwardNotes ?? [];
          previousDecision = null;
          latestDrafts = {};
          latestCritiques = {};
          await this.persistRunCursor({
            runId,
            currentTurn: nextTurnIndex,
            currentMilestoneTurn,
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
            debateMode,
            currentTaskIndex,
            finalDecision: refereeResult.decision,
            latestCritiques,
            latestDrafts,
            taskPlan,
          });
          await this.completeRunFromCurrentCycle({
            runId,
            debateMode,
            finalDecision: refereeResult.decision,
            latestDrafts,
            taskPlan,
            currentTaskIndex,
            sources: dedupeSources(collectedSources),
            stopReason: "converged",
          });
          return;
        }

        if (!milestoneBudgetRemaining) {
          if (!isFinalTask) {
            const completedTaskTitle = currentTask.title;
            currentTaskIndex += 1;
            currentMilestoneTurn = 0;
            carryForwardNotes = refereeResult.decision.carryForwardNotes ?? [];
            previousDecision = null;
            latestDrafts = {};
            latestCritiques = {};
            await this.persistRunCursor({
              runId,
              currentTurn: nextTurnIndex,
              currentMilestoneTurn,
              currentTaskIndex,
            });
            const nextTask = getCurrentTask(taskPlan, currentTaskIndex);
            publish(runId, {
              type: "status",
              status: "running",
              message: nextTask
                ? `Milestone "${completedTaskTitle}" reached ${config.maxTurns} cycle${config.maxTurns === 1 ? "" : "s"}. Advancing to ${nextTask.title} with carry-forward notes.`
                : `Milestone "${completedTaskTitle}" reached ${config.maxTurns} cycle${config.maxTurns === 1 ? "" : "s"}. Advancing to the next step.`,
              at: isoNow(),
            });
            continue;
          }

          assertCompletedCycle({
            debateMode,
            currentTaskIndex,
            finalDecision: refereeResult.decision,
            latestCritiques,
            latestDrafts,
            taskPlan,
          });
          await this.completeRunFromCurrentCycle({
            runId,
            debateMode,
            finalDecision: refereeResult.decision,
            latestDrafts,
            taskPlan,
            currentTaskIndex,
            sources: dedupeSources(collectedSources),
            stopReason: "max_turns",
          });
          return;
        }

        currentMilestoneTurn += 1;
        await this.persistRunCursor({
          runId,
          currentTurn: nextTurnIndex,
          currentMilestoneTurn,
          currentTaskIndex,
        });
        publish(runId, {
          type: "status",
          status: "running",
          message: `Referee kept milestone ${currentTaskIndex + 1} open. Re-running ${buildCycleLabel(currentMilestoneTurn, config.maxTurns)} for ${currentTask.title}.`,
          at: isoNow(),
        });
      }

      assertCompletedCycle({
        debateMode,
        currentTaskIndex,
        finalDecision: previousDecision,
        latestCritiques,
        latestDrafts,
        taskPlan,
      });
      await this.completeRunFromCurrentCycle({
        runId,
        debateMode,
        finalDecision: previousDecision!,
        latestDrafts,
        taskPlan,
        currentTaskIndex,
        sources: dedupeSources(collectedSources),
        stopReason: "max_turns",
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

  private async resolveTaskPlan(args: {
    runId: string;
    config: RunConfig;
    answeredQuestionBatches: UserQuestionBatch[];
    signal: AbortSignal;
    waitForAnswers: ExecuteRunArgs["waitForAnswers"];
  }) {
    while (true) {
      const planningResult = await this.executePlanningTurn(args);
      if (planningResult.taskPlan) {
        await saveTaskPlan(args.runId, planningResult.taskPlan);
        publish(args.runId, {
          type: "status",
          status: "running",
          message: `Milestone plan created with ${planningResult.taskPlan.length} step${planningResult.taskPlan.length === 1 ? "" : "s"}.`,
          at: isoNow(),
        });
        return planningResult.taskPlan;
      }

      if (!planningResult.questionBatch) {
        throw new Error("The planning pass did not return milestones or a clarification batch.");
      }

      await saveQuestionBatch(planningResult.questionBatch);
      publish(args.runId, {
        type: "question_batch",
        batch: planningResult.questionBatch,
        at: isoNow(),
      });
      const answeredBatch = await args.waitForAnswers(planningResult.questionBatch, args.signal);
      args.answeredQuestionBatches.push(answeredBatch);
      publish(args.runId, {
        type: "question_batch_answered",
        batch: answeredBatch,
        at: isoNow(),
      });
      publish(args.runId, {
        type: "status",
        status: "running",
        message: "Referee is replanning the milestone list with the new clarifications.",
        at: isoNow(),
      });
    }
  }

  private async executeChatCompletionWithRetry(args: {
    buildRequest: (context: { attempt: number; maxAttempts: number }) => Omit<
      Parameters<ProviderAdapter["createChatStream"]>[0],
      "signal"
    >;
    label: string;
    modelId: string;
    phase: TurnPhase;
    role: ActorRole;
    runId: string;
    signal: AbortSignal;
    turnIndex: number;
  }) {
    return executeChatWithRetry({
      label: args.label,
      signal: args.signal,
      onAttemptRetry: ({ attempt, lastError, maxAttempts, retryDelayMs }) => {
        publishTurnRetrying({
          attempt,
          lastError,
          maxAttempts,
          modelId: args.modelId,
          phase: args.phase,
          retryDelayMs,
          role: args.role,
          runId: args.runId,
          turnIndex: args.turnIndex,
        });
        publish(args.runId, {
          type: "status",
          status: "running",
          message: buildRetryStatusMessage({
            attempt,
            label: args.label,
            lastError,
            maxAttempts,
            retryDelayMs,
          }),
          at: isoNow(),
        });
      },
      onAttemptStart: ({ attempt, maxAttempts }) => {
        publishTurnStarted({
          attempt,
          maxAttempts,
          modelId: args.modelId,
          phase: args.phase,
          role: args.role,
          runId: args.runId,
          turnIndex: args.turnIndex,
        });
      },
      execute: ({ attempt, maxAttempts }) =>
        this.adapter.createChatStream({
          ...args.buildRequest({ attempt, maxAttempts }),
          signal: args.signal,
        }),
    });
  }

  private async executeStructuredChatCompletionWithRetry<T>(args: {
    buildRequest: (context: {
      attempt: number;
      maxAttempts: number;
      repairState: null | { invalidOutput: string; validationError: string };
    }) => Omit<Parameters<ProviderAdapter["createChatStream"]>[0], "signal">;
    label: string;
    modelId: string;
    phase: TurnPhase;
    responseSchema: z.ZodSchema<T>;
    role: ActorRole;
    runId: string;
    signal: AbortSignal;
    turnIndex: number;
  }) {
    let repairState: null | { invalidOutput: string; validationError: string } = null;

    return executeChatWithRetry({
      label: args.label,
      signal: args.signal,
      onAttemptRetry: ({ attempt, lastError, maxAttempts, retryDelayMs }) => {
        publishTurnRetrying({
          attempt,
          lastError,
          maxAttempts,
          modelId: args.modelId,
          phase: args.phase,
          retryDelayMs,
          role: args.role,
          runId: args.runId,
          turnIndex: args.turnIndex,
        });
        publish(args.runId, {
          type: "status",
          status: "running",
          message: buildRetryStatusMessage({
            attempt,
            label: args.label,
            lastError,
            maxAttempts,
            retryDelayMs,
          }),
          at: isoNow(),
        });
      },
      onAttemptStart: ({ attempt, maxAttempts }) => {
        publishTurnStarted({
          attempt,
          maxAttempts,
          modelId: args.modelId,
          phase: args.phase,
          role: args.role,
          runId: args.runId,
          turnIndex: args.turnIndex,
        });
      },
      execute: async ({ attempt, maxAttempts }) => {
        const response = await this.adapter.createChatStream({
          ...args.buildRequest({
            attempt,
            maxAttempts,
            repairState,
          }),
          signal: args.signal,
        });

        try {
          return {
            parsed: parseJsonFromModel(response.content, args.responseSchema),
            response,
          };
        } catch (error) {
          if (!repairState) {
            repairState = {
              invalidOutput: response.content,
              validationError: formatStructuredOutputError(error),
            };
            throw new RetryableStructuredOutputError(
              `${args.label} returned invalid structured output. ${repairState.validationError}`,
            );
          }

          throw error;
        }
      },
    });
  }

  private async executePlanningTurn(args: {
    runId: string;
    config: RunConfig;
    answeredQuestionBatches: UserQuestionBatch[];
    signal: AbortSignal;
  }) {
    assertNotAborted(args.signal);
    const start = Date.now();
    const turnIndex = -1;
    publish(args.runId, {
      type: "status",
      status: "running",
      message: "Referee is planning the milestone list.",
      at: isoNow(),
    });

    const baseMessages: ProviderMessage[] = [
      {
        role: "system",
        content: buildTaskPlanSystemPrompt(normalizeDebateMode(args.config.debateMode)),
      },
      {
        role: "user",
        content: buildTaskPlanUserPrompt({
          debateMode: normalizeDebateMode(args.config.debateMode),
          taskPrompt: args.config.taskPrompt,
          answeredQuestionBatches: args.answeredQuestionBatches,
        }),
      },
    ];

    const { parsed, response } = await this.executeStructuredChatCompletionWithRetry({
      label: "Referee planning",
      modelId: args.config.referee.modelId,
      phase: "planning",
      responseSchema: planningResponseSchema,
      role: "referee",
      runId: args.runId,
      signal: args.signal,
      turnIndex,
      buildRequest: ({ attempt, maxAttempts, repairState }) => ({
        modelId: args.config.referee.modelId,
        responseFormat: "json_object",
        temperature: 0.1,
        onTextDelta: ({ delta, content }) => {
          publishTurnDelta({
            attempt,
            runId: args.runId,
            maxAttempts,
            role: "referee",
            phase: "planning",
            turnIndex,
            modelId: args.config.referee.modelId,
            delta,
            content,
          });
        },
        messages: repairState
          ? buildStructuredRepairMessages({
              invalidOutput: repairState.invalidOutput,
              messages: baseMessages,
              validationError: repairState.validationError,
            })
          : baseMessages,
      }),
    });

    const questionBatch =
      parsed.outcome === "question_batch"
        ? createQuestionBatch(args.runId, parsed.questionBatch)
        : null;
    const taskPlan = parsed.outcome === "tasks" ? toTaskPlan(parsed.tasks) : null;

    if (!questionBatch && (!taskPlan || taskPlan.length === 0)) {
      throw new Error("Milestone planning must produce a non-empty task list or a clarification batch.");
    }

    const planningTurn: TurnRecord = {
      id: crypto.randomUUID(),
      runId: args.runId,
      turnIndex,
      role: "referee",
      phase: "planning",
      modelId: args.config.referee.modelId,
      content: JSON.stringify(parsed, null, 2),
      summary:
        parsed.outcome === "tasks"
          ? `Generated ${taskPlan!.length} task${taskPlan!.length === 1 ? "" : "s"}.`
          : parsed.summary,
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

    return {
      questionBatch,
      taskPlan,
    };
  }

  private async finalizeConsensus(args: {
    runId: string;
    debateMode: DebateMode;
    finalDecision: RefereeDecision;
    latestDrafts: ParticipantResultMap;
    taskPlan: DebateTask[];
    currentTaskIndex: number;
    sources: SourceRecord[];
  }): Promise<FinalConsensus> {
    assertFinalMilestoneForFinalization(args.taskPlan, args.currentTaskIndex);

    const { selectedTurn, usedTieFallback } = selectFinalTurn({
      debateMode: args.debateMode,
      finalDecision: args.finalDecision,
      latestDrafts: args.latestDrafts,
    });

    const finalConsensus: FinalConsensus = {
      solution: selectedTurn.content.trim(),
      rationale: buildSelectionRationale({
        finalDecision: args.finalDecision,
        selectedTurn,
        taskPlan: args.taskPlan.slice(0, args.currentTaskIndex + 1),
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

  private async completeRunFromCurrentCycle(args: {
    runId: string;
    debateMode: DebateMode;
    finalDecision: RefereeDecision;
    latestDrafts: ParticipantResultMap;
    taskPlan: DebateTask[];
    currentTaskIndex: number;
    sources: SourceRecord[];
    stopReason: "converged" | "max_turns";
  }) {
    const finalConsensus = await this.finalizeConsensus({
      runId: args.runId,
      debateMode: args.debateMode,
      finalDecision: args.finalDecision,
      latestDrafts: args.latestDrafts,
      taskPlan: args.taskPlan,
      currentTaskIndex: args.currentTaskIndex,
      sources: args.sources,
    });

    await saveFinalConsensus(args.runId, finalConsensus, args.stopReason);
    publish(args.runId, {
      type: "completed",
      finalConsensus,
      stopReason: args.stopReason,
      at: isoNow(),
    });
  }

  private async persistRunCursor(args: {
    runId: string;
    currentTurn: number;
    currentMilestoneTurn: number;
    currentTaskIndex: number;
  }) {
    await updateRunStatus(args.runId, "running", {
      currentTurn: args.currentTurn,
      currentMilestoneTurn: args.currentMilestoneTurn,
      currentTaskIndex: args.currentTaskIndex,
    });
  }

  private async executeParticipantPhaseSet(args: {
    runId: string;
    config: RunConfig;
    currentTaskIndex: number;
    currentMilestoneTurn: number;
    maxMilestoneTurns: number;
    carryForwardNotes: string[];
    debateMode: DebateMode;
    latestCritiques: ParticipantResultMap;
    latestDrafts: ParticipantResultMap;
    phase: "proposal" | "revision" | "critique";
    parallel: boolean;
    previousDecision: RefereeDecision | null;
    roles: ParticipantRole[];
    signal: AbortSignal;
    taskPlan: DebateTask[];
    turnIndex: number;
    workspaceManifest?: WorkspaceManifest | null;
    answeredQuestionBatches: UserQuestionBatch[];
  }) {
    const executeForRole = async (role: ParticipantRole) =>
      this.executeParticipantTurn({
        runId: args.runId,
        config: args.config,
        role,
        participant: getParticipantConfig(args.config, role),
        turnIndex: args.turnIndex,
        workspaceManifest: args.workspaceManifest,
        phase: args.phase,
        taskPlan: args.taskPlan,
        currentTaskIndex: args.currentTaskIndex,
        currentMilestoneTurn: args.currentMilestoneTurn,
        maxMilestoneTurns: args.maxMilestoneTurns,
        previousOwnTurn: args.latestDrafts[role]?.turn ?? null,
        previousOpponentTurn:
          args.latestDrafts[getOtherParticipantRole(role)]?.turn ?? null,
        previousOwnCritique: args.latestCritiques[role]?.turn ?? null,
        previousOpponentCritique:
          args.latestCritiques[getOtherParticipantRole(role)]?.turn ?? null,
        previousDecision: args.previousDecision,
        carryForwardNotes: args.carryForwardNotes,
        sharedEvidence:
          args.phase === "critique"
            ? args.latestDrafts[getOtherParticipantRole(role)]?.evidencePacket ?? null
            : args.latestCritiques[getOtherParticipantRole(role)]?.evidencePacket ??
              args.latestDrafts[getOtherParticipantRole(role)]?.evidencePacket ??
              null,
        answeredQuestionBatches: args.answeredQuestionBatches,
        signal: args.signal,
      });

    const results: ParticipantResultMap = {};
    if (args.parallel) {
      const entries = await Promise.all(
        args.roles.map(async (role) => [role, await executeForRole(role)] as const),
      );
      for (const [role, result] of entries) {
        results[role] = result;
      }
      return results;
    }

    for (const role of args.roles) {
      results[role] = await executeForRole(role);
    }

    return results;
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
    currentMilestoneTurn: number;
    maxMilestoneTurns: number;
    previousOwnTurn?: TurnRecord | null;
    previousOpponentTurn?: TurnRecord | null;
    previousOwnCritique?: TurnRecord | null;
    previousOpponentCritique?: TurnRecord | null;
    previousDecision?: RefereeDecision | null;
    carryForwardNotes: string[];
    sharedEvidence?: EvidencePacket | null;
    answeredQuestionBatches: UserQuestionBatch[];
    signal: AbortSignal;
  }): Promise<ParticipantTurnResult> {
    const mode = getModeDefinition(args.config.debateMode);
    const start = Date.now();
    const turnId = crypto.randomUUID();

    if (args.phase === "critique" && !mode.critiqueRoles.includes(args.role)) {
      throw new Error(
        `${getDebateRoleLabel(mode.id, args.role)} cannot enter critique phase in ${mode.id}.`,
      );
    }

    if (args.phase !== "critique" && !mode.draftRoles.includes(args.role)) {
      throw new Error(
        `${getDebateRoleLabel(mode.id, args.role)} cannot enter draft phase in ${mode.id}.`,
      );
    }

    if (args.phase === "critique" && !args.previousOpponentTurn) {
      throw new Error(`${args.role} cannot enter critique phase without an authored output to review.`);
    }

    if (
      args.phase === "critique" &&
      mode.draftRoles.includes(args.role) &&
      !args.previousOwnTurn
    ) {
      throw new Error(`${args.role} cannot critique without its own authored output in the current mode.`);
    }

    const messages: ProviderMessage[] = [
      {
        role: "system",
        content: buildParticipantSystemPrompt({
          debateMode: mode.id,
          role: args.role,
          persona: args.participant.persona,
          manifest: args.workspaceManifest,
        }),
      },
      {
        role: "user",
        content:
          args.phase === "critique"
            ? buildParticipantCritiqueUserPrompt({
                debateMode: mode.id,
                role: args.role,
                taskPrompt: args.config.taskPrompt,
                taskPlan: args.taskPlan,
                currentTaskIndex: args.currentTaskIndex,
                currentMilestoneTurn: args.currentMilestoneTurn,
                maxMilestoneTurns: args.maxMilestoneTurns,
                turnIndex: args.turnIndex,
                ownTurn: args.previousOwnTurn,
                opponentTurn: args.previousOpponentTurn!,
                previousDecision: args.previousDecision,
                carryForwardNotes: args.carryForwardNotes,
                sharedEvidence: args.sharedEvidence,
                answeredQuestionBatches: args.answeredQuestionBatches,
              })
            : buildParticipantUserPrompt({
                debateMode: mode.id,
                role: args.role,
                taskPrompt: args.config.taskPrompt,
                taskPlan: args.taskPlan,
                currentTaskIndex: args.currentTaskIndex,
                currentMilestoneTurn: args.currentMilestoneTurn,
                maxMilestoneTurns: args.maxMilestoneTurns,
                turnIndex: args.turnIndex,
                phase: args.phase,
                previousOwnTurn: args.previousOwnTurn,
                previousOpponentTurn: args.previousOpponentTurn,
                previousOwnCritique: args.previousOwnCritique,
                previousOpponentCritique: args.previousOpponentCritique,
                previousDecision: args.previousDecision,
                carryForwardNotes: args.carryForwardNotes,
                sharedEvidence: args.sharedEvidence,
                answeredQuestionBatches: args.answeredQuestionBatches,
              }),
      },
    ];

    const toolInvocations: ToolInvocationRecord[] = [];
    const collectedSources: SourceRecord[] = [];
    const questionProposals: UserQuestionProposal[] = [];
    let latestUsage: TurnRecord["tokenUsage"] = null;

    for (let loopCount = 0; loopCount < PARTICIPANT_MAX_TOOL_EXCHANGES; loopCount += 1) {
      assertNotAborted(args.signal);
      const response = await this.executeChatCompletionWithRetry({
        label: `${getDebateRoleLabel(mode.id, args.role)} ${formatPhaseName(args.phase)}`,
        modelId: args.participant.modelId,
        phase: args.phase,
        role: args.role,
        runId: args.runId,
        signal: args.signal,
        turnIndex: args.turnIndex,
        buildRequest: ({ attempt, maxAttempts }) => ({
          modelId: args.participant.modelId,
          messages,
          tools: participantToolDefinitions,
          temperature: 0.3,
          onTextDelta: ({ delta, content }) => {
            publishTurnDelta({
              attempt,
              runId: args.runId,
              maxAttempts,
              role: args.role,
              phase: args.phase,
              turnIndex: args.turnIndex,
              modelId: args.participant.modelId,
              delta,
              content,
            });
          },
        }),
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
        const evidencePacket = buildEvidencePacket({
          role: args.role,
          turn,
          toolInvocations,
          sources: collectedSources,
        });
        publish(args.runId, {
          type: "turn_completed",
          turn,
          at: isoNow(),
        });

        return {
          evidencePacket,
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
          signal: args.signal,
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

    throw new Error(
      `${args.role} exceeded the maximum tool exchange count (${PARTICIPANT_MAX_TOOL_EXCHANGES}).`,
    );
  }

  private async executeRefereeTurn(args: {
    runId: string;
    config: RunConfig;
    currentTaskIndex: number;
    currentMilestoneTurn: number;
    maxMilestoneTurns: number;
    carryForwardNotes: string[];
    debateMode: DebateMode;
    latestCritiques: ParticipantResultMap;
    latestDrafts: ParticipantResultMap;
    previousDecision?: RefereeDecision | null;
    answeredQuestionBatches: UserQuestionBatch[];
    questionProposals: Record<ParticipantRole, UserQuestionProposal[]>;
    signal: AbortSignal;
    taskPlan: DebateTask[];
    turnIndex: number;
  }) {
    assertNotAborted(args.signal);
    const mode = getModeDefinition(args.debateMode);

    for (const role of mode.draftRoles) {
      const turn = args.latestDrafts[role]?.turn ?? null;
      if (!turn) {
        throw new Error("The referee cannot evaluate a milestone before the mode's draft steps are complete.");
      }
      if (turn.turnIndex !== args.turnIndex) {
        throw new Error("The referee can only evaluate a completed cycle for the current milestone.");
      }
    }

    for (const role of mode.critiqueRoles) {
      const turn = args.latestCritiques[role]?.turn ?? null;
      if (!turn) {
        throw new Error("The referee cannot evaluate a milestone before the mode's critique steps are complete.");
      }
      if (turn.turnIndex !== args.turnIndex) {
        throw new Error("The referee can only evaluate a completed cycle for the current milestone.");
      }
    }

    const start = Date.now();
    const baseMessages: ProviderMessage[] = [
      {
        role: "system",
        content: buildRefereeSystemPrompt({
          debateMode: mode.id,
          persona: args.config.referee.persona,
        }),
      },
      {
        role: "user",
        content: buildRefereeUserPrompt({
          debateMode: mode.id,
          taskPrompt: args.config.taskPrompt,
          taskPlan: args.taskPlan,
          currentTaskIndex: args.currentTaskIndex,
          currentMilestoneTurn: args.currentMilestoneTurn,
          maxMilestoneTurns: args.maxMilestoneTurns,
          turnIndex: args.turnIndex,
          participantATurn: args.latestDrafts.participant_a?.turn ?? null,
          participantBTurn: args.latestDrafts.participant_b?.turn ?? null,
          participantACritique: args.latestCritiques.participant_a?.turn ?? null,
          participantBCritique: args.latestCritiques.participant_b?.turn ?? null,
          previousDecision: args.previousDecision,
          carryForwardNotes: args.carryForwardNotes,
          evidencePackets: dedupeEvidencePackets([
            args.latestDrafts.participant_a?.evidencePacket ?? null,
            args.latestDrafts.participant_b?.evidencePacket ?? null,
            args.latestCritiques.participant_a?.evidencePacket ?? null,
            args.latestCritiques.participant_b?.evidencePacket ?? null,
          ]),
          answeredQuestionBatches: args.answeredQuestionBatches,
          questionProposals: [
            {
              role: "participant_a",
              proposals: args.questionProposals.participant_a,
            },
            {
              role: "participant_b",
              proposals: args.questionProposals.participant_b,
            },
          ],
        }),
      },
    ];

    const { parsed: parsedDecision, response } =
      await this.executeStructuredChatCompletionWithRetry({
        label: "Referee evaluation",
        modelId: args.config.referee.modelId,
        phase: "referee",
        responseSchema: refereeDecisionSchema,
        role: "referee",
        runId: args.runId,
        signal: args.signal,
        turnIndex: args.turnIndex,
        buildRequest: ({ attempt, maxAttempts, repairState }) => ({
          modelId: args.config.referee.modelId,
          responseFormat: "json_object",
          temperature: 0.2,
          onTextDelta: ({ delta, content }) => {
            publishTurnDelta({
              attempt,
              runId: args.runId,
              maxAttempts,
              role: "referee",
              phase: "referee",
              turnIndex: args.turnIndex,
              modelId: args.config.referee.modelId,
              delta,
              content,
            });
          },
          messages: repairState
            ? buildStructuredRepairMessages({
                invalidOutput: repairState.invalidOutput,
                messages: baseMessages,
                validationError: repairState.validationError,
              })
            : baseMessages,
        }),
      });
    validateRefereeDecisionForMode(mode.id, parsedDecision);

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
      blockingIssues: parsedDecision.blockingIssues ?? [],
      carryForwardNotes: parsedDecision.carryForwardNotes ?? [],
      diminishingReturns: parsedDecision.diminishingReturns ?? [],
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
      latencyMs: Date.now() - start,
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

    return { decision, turn };
  }
}
