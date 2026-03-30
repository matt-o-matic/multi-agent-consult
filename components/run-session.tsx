"use client";

import Link from "next/link";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useTransition,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { getDebateModeLabel, getDebateOutputLabels } from "@/lib/debate-mode";
import type {
  ActorRole,
  RefereeDecision,
  RunDetail,
  RunEvent,
  RunLiveState,
  SourceRecord,
  TurnPhase,
  UserQuestionAnswer,
} from "@/lib/types";

interface RunSessionProps {
  initialRun: RunDetail;
}

interface LiveTurn {
  attempt?: number;
  content: string;
  lastError?: string | null;
  maxAttempts?: number;
  modelId: string;
  phase: TurnPhase;
  retryDelayMs?: number | null;
  role: ActorRole;
  startedAt: string;
  turnIndex: number;
  updatedAt: string;
}

interface QuestionBatchPreview {
  questions: Array<{
    id: string;
    question: string;
  }>;
}

interface RefereeDecisionViewModel
  extends Pick<
    RefereeDecision,
    | "converged"
    | "confidence"
    | "summary"
    | "preferredDraft"
    | "requiredNextFocus"
    | "remainingDisagreements"
    | "needsUserInput"
  > {
  blockingIssues: string[];
  carryForwardNotes: string[];
  diminishingReturns: string[];
  questionBatch: QuestionBatchPreview | null;
}

interface FinalConsensusPreview {
  solution: string;
  rationale: string;
}

function toLiveTurnMap(activeTurns?: RunLiveState["activeTurns"] | null) {
  return Object.fromEntries(
    (activeTurns ?? []).map((turn) => [
      liveTurnKey(turn.role, turn.phase, turn.turnIndex),
      {
        attempt: turn.attempt,
        content: turn.content,
        lastError: turn.lastError ?? null,
        maxAttempts: turn.maxAttempts,
        modelId: turn.modelId,
        phase: turn.phase,
        retryDelayMs: turn.retryDelayMs ?? null,
        role: turn.role,
        startedAt: turn.startedAt,
        turnIndex: turn.turnIndex,
        updatedAt: turn.updatedAt,
      } satisfies LiveTurn,
    ]),
  ) as Record<string, LiveTurn>;
}

function groupSourcesByTurn(run: RunDetail) {
  const map = new Map<string, SourceRecord[]>();
  for (const source of run.sources) {
    if (!source.turnId) {
      continue;
    }

    const existing = map.get(source.turnId) ?? [];
    existing.push(source);
    map.set(source.turnId, existing);
  }
  return map;
}

function currentMilestoneStartTurn(run: RunDetail) {
  return Math.max(0, run.currentTurn - run.currentMilestoneTurn);
}

function liveTurnKey(role: ActorRole, phase: TurnPhase, turnIndex: number) {
  return `${role}:${phase}:${turnIndex}`;
}

async function fetchRun(runId: string) {
  const response = await fetch(`/api/runs/${runId}`);
  const payload = (await response.json()) as { error?: string; run?: RunDetail };
  if (!response.ok || !payload.run) {
    throw new Error(payload.error ?? "Could not refresh run state.");
  }

  return payload.run;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseRefereeDecision(content: string): RefereeDecisionViewModel | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isObjectRecord(parsed)) {
      return null;
    }

    if (
      typeof parsed.converged !== "boolean" ||
      typeof parsed.confidence !== "number" ||
      typeof parsed.summary !== "string" ||
      typeof parsed.preferredDraft !== "string" ||
      typeof parsed.requiredNextFocus !== "string" ||
      typeof parsed.remainingDisagreements !== "string" ||
      typeof parsed.needsUserInput !== "boolean"
    ) {
      return null;
    }

    const questionBatch =
      isObjectRecord(parsed.questionBatch) &&
      Array.isArray(parsed.questionBatch.questions)
        ? {
            questions: parsed.questionBatch.questions
              .filter(isObjectRecord)
              .map((question, index) => ({
                id:
                  typeof question.id === "string" && question.id.length > 0
                    ? question.id
                    : `question-${index}`,
                question:
                  typeof question.question === "string" ? question.question : "Question",
              })),
          }
        : null;

    return {
      converged: parsed.converged,
      confidence: parsed.confidence,
      summary: parsed.summary,
      preferredDraft:
        parsed.preferredDraft === "participant_a" ||
        parsed.preferredDraft === "participant_b" ||
        parsed.preferredDraft === "tie"
          ? parsed.preferredDraft
          : "tie",
      requiredNextFocus: parsed.requiredNextFocus,
      remainingDisagreements: parsed.remainingDisagreements,
      blockingIssues: Array.isArray(parsed.blockingIssues)
        ? parsed.blockingIssues.filter((value): value is string => typeof value === "string")
        : [],
      carryForwardNotes: Array.isArray(parsed.carryForwardNotes)
        ? parsed.carryForwardNotes.filter((value): value is string => typeof value === "string")
        : [],
      diminishingReturns: Array.isArray(parsed.diminishingReturns)
        ? parsed.diminishingReturns.filter((value): value is string => typeof value === "string")
        : [],
      needsUserInput: parsed.needsUserInput,
      questionBatch,
    };
  } catch {
    return null;
  }
}

function toRefereeDecisionViewModel(
  decision: Pick<
    RefereeDecision,
    | "converged"
    | "confidence"
    | "summary"
    | "preferredDraft"
    | "requiredNextFocus"
    | "remainingDisagreements"
    | "blockingIssues"
    | "carryForwardNotes"
    | "diminishingReturns"
    | "needsUserInput"
    | "questionBatch"
  >,
): RefereeDecisionViewModel {
  return {
    converged: decision.converged,
    confidence: decision.confidence,
    summary: decision.summary,
    preferredDraft: decision.preferredDraft,
    requiredNextFocus: decision.requiredNextFocus,
    remainingDisagreements: decision.remainingDisagreements,
    blockingIssues: decision.blockingIssues ?? [],
    carryForwardNotes: decision.carryForwardNotes ?? [],
    diminishingReturns: decision.diminishingReturns ?? [],
    needsUserInput: decision.needsUserInput,
    questionBatch: decision.questionBatch
      ? {
          questions: decision.questionBatch.questions.map((question, index) => ({
            id: question.id || `question-${index}`,
            question: question.question,
          })),
        }
      : null,
  };
}

function parseFinalConsensusPreview(content: string): FinalConsensusPreview | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      !isObjectRecord(parsed) ||
      typeof parsed.solution !== "string" ||
      typeof parsed.rationale !== "string"
    ) {
      return null;
    }

    return {
      solution: parsed.solution,
      rationale: parsed.rationale,
    };
  } catch {
    return null;
  }
}

function parseTaskPlanPreview(content: string): RunDetail["taskPlan"] | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isObjectRecord(parsed) || !Array.isArray(parsed.tasks)) {
      return null;
    }

    const tasks = parsed.tasks
      .filter(isObjectRecord)
      .map((task, index) => ({
        id: typeof task.id === "string" ? task.id : `task-${index}`,
        title: typeof task.title === "string" ? task.title : `Task ${index + 1}`,
        objective:
          typeof task.objective === "string" ? task.objective : "No objective provided.",
        completionCriteria:
          typeof task.completionCriteria === "string"
            ? task.completionCriteria
            : "No completion criteria provided.",
      }));

    return tasks.length > 0 ? tasks : null;
  } catch {
    return null;
  }
}

function latestPersistedTurn(turns: RunDetail["turns"], role: ActorRole) {
  return [...turns]
    .filter((turn) => turn.role === role)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1) ?? null;
}

function latestEvidenceTurnForRole(args: {
  role: ActorRole;
  run: RunDetail;
  sourcesByTurn: Map<string, SourceRecord[]>;
}) {
  const milestoneStart = currentMilestoneStartTurn(args.run);

  return [...args.run.turns]
    .filter(
      (turn) =>
        turn.role === args.role &&
        turn.turnIndex >= milestoneStart &&
        (args.sourcesByTurn.get(turn.id)?.length ?? 0) > 0,
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1) ?? null;
}

function latestLiveTurn(liveTurns: Record<string, LiveTurn>, role: ActorRole) {
  return Object.values(liveTurns)
    .filter((turn) => turn.role === role)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .at(-1) ?? null;
}

function formatElapsed(iso: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function isActiveRunStatus(status: RunDetail["status"]) {
  return ["queued", "running", "waiting_for_user"].includes(status);
}

function getRoleLabels(run: Pick<RunDetail, "participantA" | "participantB" | "referee">) {
  return {
    participant_a: run.participantA.label,
    participant_b: run.participantB.label,
    referee: run.referee.label,
  } satisfies Record<ActorRole, string>;
}

function formatPhaseName(phase: TurnPhase) {
  switch (phase) {
    case "planning":
      return "planning";
    case "proposal":
      return "proposal";
    case "revision":
      return "revision";
    case "critique":
      return "critique";
    case "referee":
      return "evaluation";
    case "final":
      return "final";
    default:
      return phase;
  }
}

function getMilestoneStatus(
  index: number,
  currentTaskIndex: number,
  runStatus: RunDetail["status"],
) {
  if (runStatus === "completed") {
    return "completed";
  }

  if (index < currentTaskIndex) {
    return "completed";
  }

  if (index === currentTaskIndex) {
    return "current";
  }

  return "pending";
}

function getCurrentMilestone(
  taskPlan: RunDetail["taskPlan"],
  currentTaskIndex: number,
  runStatus: RunDetail["status"],
) {
  if (taskPlan.length === 0) {
    return null;
  }

  if (runStatus === "completed") {
    return taskPlan.at(-1) ?? null;
  }

  return taskPlan[currentTaskIndex] ?? taskPlan.at(-1) ?? null;
}

function getRemainingMilestoneCount(
  taskPlan: RunDetail["taskPlan"],
  currentTaskIndex: number,
  runStatus: RunDetail["status"],
) {
  if (runStatus === "completed") {
    return 0;
  }

  return Math.max(0, taskPlan.length - currentTaskIndex - 1);
}

function countParticipantOutputs(turns: RunDetail["turns"], role: "participant_a" | "participant_b") {
  const proposalLike = turns.filter(
    (turn) =>
      turn.role === role && (turn.phase === "proposal" || turn.phase === "revision"),
  ).length;
  const critiques = turns.filter(
    (turn) => turn.role === role && turn.phase === "critique",
  ).length;

  return {
    critiques,
    proposalLike,
    total: proposalLike + critiques,
  };
}

function countRefereeOutputs(turns: RunDetail["turns"]) {
  const planning = turns.filter(
    (turn) => turn.role === "referee" && turn.phase === "planning",
  ).length;
  const evaluations = turns.filter(
    (turn) => turn.role === "referee" && turn.phase === "referee",
  ).length;

  return {
    evaluations,
    planning,
    total: planning + evaluations,
  };
}

function buildActivityState(args: {
  liveTurn: LiveTurn | null;
  now: number | null;
  runStatus: RunDetail["status"];
}) {
  if (args.liveTurn) {
    const attemptDetail =
      typeof args.liveTurn.attempt === "number" &&
      typeof args.liveTurn.maxAttempts === "number"
        ? `attempt ${args.liveTurn.attempt} of ${args.liveTurn.maxAttempts}`
        : null;

    if (
      typeof args.liveTurn.retryDelayMs === "number" &&
      args.liveTurn.lastError
    ) {
      return {
        attemptDetail,
        detail: `retrying ${formatPhaseName(args.liveTurn.phase)}`,
        isActive: true,
        isStreaming: false,
        label: "retrying",
        lastError: args.liveTurn.lastError,
        retryDelayLabel:
          args.liveTurn.retryDelayMs > 0
            ? `backoff ${Math.ceil(args.liveTurn.retryDelayMs / 1000)}s`
            : "retrying now",
      };
    }

    const hasContent = args.liveTurn.content.trim().length > 0;
    const verb = hasContent ? "streaming" : "thinking";
    const elapsed = args.now ? ` for ${formatElapsed(args.liveTurn.startedAt, args.now)}` : "";

    return {
      attemptDetail,
      detail: `${verb} ${formatPhaseName(args.liveTurn.phase)}${elapsed}`,
      isActive: true,
      isStreaming: hasContent,
      label: verb,
      lastError: null,
      retryDelayLabel: null,
    };
  }

  if (args.runStatus === "waiting_for_user") {
    return {
      attemptDetail: null,
      detail: "paused for user input",
      isActive: false,
      isStreaming: false,
      label: "paused",
      lastError: null,
      retryDelayLabel: null,
    };
  }

  if (isActiveRunStatus(args.runStatus)) {
    return {
      attemptDetail: null,
      detail: "idle",
      isActive: false,
      isStreaming: false,
      label: "idle",
      lastError: null,
      retryDelayLabel: null,
    };
  }

  return {
    attemptDetail: null,
    detail: "idle",
    isActive: false,
    isStreaming: false,
    label: "idle",
    lastError: null,
    retryDelayLabel: null,
  };
}

function MarkdownBlock({ content }: { content: string }) {
  return (
    <div className="prose-output">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{content}</ReactMarkdown>
    </div>
  );
}

function CopyButtons({
  getHtml,
  raw,
}: {
  getHtml?: () => string;
  raw: string;
}) {
  const [copied, setCopied] = useState<"html" | "markdown" | null>(null);

  async function handleCopy(mode: "html" | "markdown") {
    const value = mode === "markdown" ? raw : getHtml?.() ?? "";
    if (!value) {
      return;
    }

    await navigator.clipboard.writeText(value);
    setCopied(mode);
    window.setTimeout(() => setCopied(null), 1200);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void handleCopy("markdown")}
        className="rounded-full border border-[var(--line)] px-3 py-1 text-xs"
      >
        Copy markdown
      </button>
      <button
        type="button"
        onClick={() => void handleCopy("html")}
        disabled={!getHtml}
        className="rounded-full border border-[var(--line)] px-3 py-1 text-xs disabled:opacity-50"
      >
        Copy HTML
      </button>
      {copied ? (
        <span className="mono text-xs text-[var(--ink-soft)]">copied {copied}</span>
      ) : null}
    </div>
  );
}

function RefereeDecisionCard({
  decision,
  compact = false,
}: {
  decision: RefereeDecisionViewModel;
  compact?: boolean;
}) {
  const confidence = `${Math.round(decision.confidence * 100)}%`;

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap gap-2">
        <span className="status-pill rounded-full px-3 py-1 text-xs">
          {decision.converged ? "converged" : "still diverging"}
        </span>
        <span className="status-pill rounded-full px-3 py-1 text-xs">
          confidence {confidence}
        </span>
        <span className="status-pill rounded-full px-3 py-1 text-xs">
          preferred {decision.preferredDraft}
        </span>
        {decision.needsUserInput ? (
          <span className="status-pill rounded-full px-3 py-1 text-xs">
            needs user input
          </span>
        ) : null}
      </div>

      <div className={compact ? "grid gap-3" : "grid gap-4 md:grid-cols-3"}>
        <div className="rounded-[1.1rem] border border-[var(--line)] bg-white/80 p-4">
          <div className="eyebrow">Summary</div>
          <p className="mt-2 text-sm leading-6 text-[var(--foreground)]">
            {decision.summary}
          </p>
        </div>
        <div className="rounded-[1.1rem] border border-[var(--line)] bg-white/80 p-4">
          <div className="eyebrow">Next Focus</div>
          <p className="mt-2 text-sm leading-6 text-[var(--foreground)]">
            {decision.requiredNextFocus}
          </p>
        </div>
        <div className="rounded-[1.1rem] border border-[var(--line)] bg-white/80 p-4">
          <div className="eyebrow">Disagreements</div>
          <p className="mt-2 text-sm leading-6 text-[var(--foreground)]">
            {decision.remainingDisagreements}
          </p>
        </div>
      </div>

      {decision.blockingIssues.length ||
      decision.carryForwardNotes.length ||
      decision.diminishingReturns.length ? (
        <div className={compact ? "grid gap-3" : "grid gap-4 md:grid-cols-3"}>
          <div className="rounded-[1.1rem] border border-[var(--line)] bg-white/80 p-4">
            <div className="eyebrow">Blocking Now</div>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-[var(--foreground)]">
              {decision.blockingIssues.length ? (
                decision.blockingIssues.map((issue, index) => <li key={`block-${index}`}>{issue}</li>)
              ) : (
                <li className="text-[var(--ink-soft)]">No blocking issues.</li>
              )}
            </ul>
          </div>
          <div className="rounded-[1.1rem] border border-[var(--line)] bg-white/80 p-4">
            <div className="eyebrow">Carry Forward</div>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-[var(--foreground)]">
              {decision.carryForwardNotes.length ? (
                decision.carryForwardNotes.map((note, index) => <li key={`carry-${index}`}>{note}</li>)
              ) : (
                <li className="text-[var(--ink-soft)]">No carry-forward notes.</li>
              )}
            </ul>
          </div>
          <div className="rounded-[1.1rem] border border-[var(--line)] bg-white/80 p-4">
            <div className="eyebrow">Diminishing Returns</div>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-[var(--foreground)]">
              {decision.diminishingReturns.length ? (
                decision.diminishingReturns.map((item, index) => <li key={`dim-${index}`}>{item}</li>)
              ) : (
                <li className="text-[var(--ink-soft)]">No diminishing-return notes.</li>
              )}
            </ul>
          </div>
        </div>
      ) : null}

      {decision.questionBatch?.questions?.length ? (
        <div className="rounded-[1.1rem] border border-[var(--line)] bg-white/80 p-4">
          <div className="eyebrow">Pending Questions</div>
          <ol className="mt-3 space-y-2 text-sm leading-6 text-[var(--foreground)]">
            {decision.questionBatch.questions.map((question) => (
              <li key={question.id}>{question.question}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

function FinalConsensusPreviewCard({ preview }: { preview: FinalConsensusPreview }) {
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
      <div className="rounded-[1.1rem] border border-[var(--line)] bg-white/80 p-4">
        <div className="eyebrow">Solution</div>
        <div className="mt-3">
          <MarkdownBlock content={preview.solution} />
        </div>
      </div>
      <div className="rounded-[1.1rem] border border-[var(--line)] bg-white/80 p-4">
        <div className="eyebrow">Rationale</div>
        <div className="mt-3 text-sm text-[var(--ink-soft)]">
          <MarkdownBlock content={preview.rationale} />
        </div>
      </div>
    </div>
  );
}

function TaskPlanCard({
  currentTaskIndex,
  compact = false,
  runStatus,
  taskPlan,
  title = "Milestones",
}: {
  currentTaskIndex: number;
  compact?: boolean;
  runStatus: RunDetail["status"];
  taskPlan: RunDetail["taskPlan"];
  title?: string;
}) {
  if (taskPlan.length === 0) {
    return null;
  }

  return (
    <div className={compact ? "mt-5" : "mt-8"}>
      <p className="eyebrow">{title}</p>
      <div className={compact ? "mt-4 space-y-2" : "mt-4 space-y-3"}>
        {taskPlan.map((task, index) => {
          const status = getMilestoneStatus(index, currentTaskIndex, runStatus);

          return (
            <article
              key={task.id}
              className={`rounded-[1.2rem] border border-[var(--line)] bg-white/70 ${
                compact ? "p-3" : "p-4"
              }`}
            >
              <div className="flex items-start gap-3">
                <span
                  className={`milestone-check mt-1 ${
                    status === "completed"
                      ? "milestone-check-completed"
                      : status === "current"
                        ? "milestone-check-current"
                        : "milestone-check-pending"
                  }`}
                  aria-hidden="true"
                >
                  {status === "completed" ? "x" : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{task.title}</span>
                    <span className="status-pill rounded-full px-3 py-1 text-xs">
                      {status === "current" ? "in progress" : status}
                    </span>
                  </div>
                  {!compact ? (
                    <>
                      <p className="mt-3 text-sm leading-6 text-[var(--foreground)]">
                        {task.objective}
                      </p>
                      <p className="mt-2 text-xs leading-5 text-[var(--ink-soft)]">
                        Done when: {task.completionCriteria}
                      </p>
                    </>
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function MilestoneOverviewCard({
  currentTaskIndex,
  currentMilestoneTurn,
  maxMilestoneTurns,
  pendingBatch,
  runStatus,
  taskPlan,
}: {
  currentTaskIndex: number;
  currentMilestoneTurn: number;
  maxMilestoneTurns: number;
  pendingBatch: NonNullable<RunDetail["questionBatches"][number]> | null;
  runStatus: RunDetail["status"];
  taskPlan: RunDetail["taskPlan"];
}) {
  const currentMilestone = getCurrentMilestone(taskPlan, currentTaskIndex, runStatus);
  const remainingMilestones = getRemainingMilestoneCount(taskPlan, currentTaskIndex, runStatus);
  const planningPaused = !currentMilestone && !!pendingBatch;

  return (
    <section className="panel rounded-[2rem] p-6 lg:col-span-2" data-testid="milestone-overview">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow">Milestones</p>
          <h2 className="mt-1 text-2xl font-semibold">Milestone checklist</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="status-pill rounded-full px-3 py-1 text-xs">
            total {taskPlan.length}
          </span>
          <span className="status-pill rounded-full px-3 py-1 text-xs">
            cycle {currentMilestoneTurn + 1} of {maxMilestoneTurns}
          </span>
          <span className="status-pill rounded-full px-3 py-1 text-xs">
            remaining {remainingMilestones}
          </span>
        </div>
      </div>

      {currentMilestone ? (
        <div className="mt-4 rounded-[1.3rem] border border-[var(--line)] bg-white/75 p-4">
          <div className="eyebrow">Current milestone</div>
          <h3 className="mt-2 text-lg font-semibold">{currentMilestone.title}</h3>
          <div className="mt-2 text-sm font-medium text-[var(--ink-soft)]">
            Cycle {currentMilestoneTurn + 1} of {maxMilestoneTurns}
          </div>
          <p className="mt-2 text-sm leading-6 text-[var(--foreground)]">
            {currentMilestone.objective}
          </p>
        </div>
      ) : (
        <div className="mt-4 rounded-[1.3rem] border border-dashed border-[var(--line)] px-4 py-5 text-sm text-[var(--ink-soft)]">
          {planningPaused
            ? "Planning is waiting on user input before the milestone list can be finalized."
            : "The referee is still planning the milestones."}
        </div>
      )}

      <TaskPlanCard
        compact
        currentTaskIndex={currentTaskIndex}
        runStatus={runStatus}
        taskPlan={taskPlan}
      />
    </section>
  );
}

function ThinkingState({
  detail,
  phase,
  roleLabel,
  stateLabel,
}: {
  detail: string;
  phase: TurnPhase;
  roleLabel: string;
  stateLabel: string;
}) {
  return (
    <div className="rounded-[1rem] border border-dashed border-[var(--line)] bg-white/70 px-4 py-6 text-sm text-[var(--ink-soft)]">
      <div className="flex items-center gap-3">
          <span className="thinking-indicator" aria-hidden="true">
            <span className="thinking-orb" />
            <span className="thinking-orb" />
            <span className="thinking-orb" />
          </span>
        <div>
          <div className="font-medium text-[var(--foreground)]">
            {roleLabel} is {stateLabel}
          </div>
          <div className="mt-1">
            {formatPhaseName(phase)} in progress. {detail}
          </div>
        </div>
      </div>
    </div>
  );
}

function RoleSummaryCard({
  breakdown,
  liveTurn,
  modelId,
  now,
  primaryLabel,
  primaryValue,
  roleLabel,
  roleTestId,
  runStatus,
  secondaryLabel,
  secondaryValue,
}: {
  breakdown: number;
  liveTurn: LiveTurn | null;
  modelId: string;
  now: number | null;
  primaryLabel: string;
  primaryValue: number;
  roleLabel: string;
  roleTestId: ActorRole;
  runStatus: RunDetail["status"];
  secondaryLabel: string;
  secondaryValue: number;
}) {
  const activity = buildActivityState({
    liveTurn,
    now,
    runStatus,
  });

  return (
    <section className="panel rounded-[2rem] p-6" data-testid={`summary-${roleTestId}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow">{roleLabel}</p>
          <h2 className="mt-1 text-lg font-semibold break-all">{modelId}</h2>
        </div>
        <span className="status-pill rounded-full px-3 py-1 text-xs">
          {activity.attemptDetail
            ? `${activity.detail}, ${activity.attemptDetail}`
            : activity.detail}
        </span>
      </div>

      <div className="mt-5 rounded-[1.3rem] border border-[var(--line)] bg-white/75 p-4">
        <div className="eyebrow">Completed outputs</div>
        <div className="mt-2 text-3xl font-semibold">
          {breakdown}
          <span className="ml-2 text-sm font-medium text-[var(--ink-soft)]">
            completed outputs
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/75 p-4">
          <div className="text-sm text-[var(--ink-soft)]">{primaryLabel}</div>
          <div className="mt-1 text-2xl font-semibold">{primaryValue}</div>
        </div>
        <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/75 p-4">
          <div className="text-sm text-[var(--ink-soft)]">{secondaryLabel}</div>
          <div className="mt-1 text-2xl font-semibold">{secondaryValue}</div>
        </div>
      </div>
    </section>
  );
}

function CollapsiblePanel({
  actions,
  children,
  defaultOpen = false,
  eyebrow,
  summaryText,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  eyebrow: string;
  summaryText?: string;
  title: string;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <section className="panel rounded-[1.5rem] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2 className="mt-1 text-xl font-semibold">{title}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {isOpen && actions ? actions : null}
          <button
            type="button"
            onClick={() => setIsOpen((current) => !current)}
            className="status-pill rounded-full px-4 py-2 text-sm font-medium transition hover:bg-white/85"
          >
            {isOpen ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      {!isOpen && summaryText ? (
        <p className="mt-4 text-sm leading-6 text-[var(--ink-soft)]">{summaryText}</p>
      ) : null}

      {isOpen ? <div className="mt-4">{children}</div> : null}
    </section>
  );
}

function PromptCard({ prompt }: { prompt: string }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const preview = prompt.replace(/\s+/g, " ").trim();

  return (
    <CollapsiblePanel
      actions={<CopyButtons raw={prompt} getHtml={() => contentRef.current?.innerHTML ?? ""} />}
      eyebrow="Prompt"
      summaryText={
        preview.length > 260 ? `${preview.slice(0, 257).trimEnd()}...` : preview
      }
      title="Prompt details"
    >
      <div
        ref={contentRef}
        className="max-h-[30rem] overflow-auto rounded-[1.1rem] bg-white/75 p-4"
      >
        <MarkdownBlock content={prompt} />
      </div>
    </CollapsiblePanel>
  );
}

function RefereeMilestoneCard({
  currentTaskIndex,
  pendingBatch,
  previewTaskPlan,
  runStatus,
  taskPlan,
}: {
  currentTaskIndex: number;
  pendingBatch: NonNullable<RunDetail["questionBatches"][number]> | null;
  previewTaskPlan: RunDetail["taskPlan"] | null;
  runStatus: RunDetail["status"];
  taskPlan: RunDetail["taskPlan"];
}) {
  const currentMilestone = getCurrentMilestone(taskPlan, currentTaskIndex, runStatus);

  return (
    <div className="mt-4 rounded-[1.1rem] border border-[var(--line)] bg-white/75 p-4">
      <div className="eyebrow">
        {previewTaskPlan && taskPlan.length === 0 ? "Planning preview" : "Milestone focus"}
      </div>
      {previewTaskPlan && taskPlan.length === 0 ? (
        <ol className="mt-3 space-y-2 text-sm leading-6 text-[var(--foreground)]">
          {previewTaskPlan.map((task, index) => (
            <li key={task.id}>
              {index + 1}. {task.title}
            </li>
          ))}
        </ol>
      ) : currentMilestone ? (
        <>
          <h3 className="mt-2 text-base font-semibold">{currentMilestone.title}</h3>
          <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
            {currentMilestone.objective}
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
          {pendingBatch
            ? "Planning is waiting on user input."
            : "Waiting for milestone planning."}
        </p>
      )}
    </div>
  );
}

function LiveRolePanel({
  currentTaskIndex,
  currentMilestoneTurn,
  evidenceSources,
  latestDecision,
  liveTurn,
  maxMilestoneTurns,
  modelId,
  now,
  role,
  roleLabel,
  runStatus,
  sharedEvidenceLabel,
  sharedEvidenceSources,
  statusMessage,
  taskPlan,
  turn,
  pendingBatch,
}: {
  currentTaskIndex: number;
  currentMilestoneTurn: number;
  evidenceSources: SourceRecord[];
  latestDecision: RefereeDecisionViewModel | null;
  liveTurn: LiveTurn | null;
  maxMilestoneTurns: number;
  modelId: string;
  now: number | null;
  role: ActorRole;
  roleLabel: string;
  runStatus: RunDetail["status"];
  sharedEvidenceLabel?: string | null;
  sharedEvidenceSources: SourceRecord[];
  statusMessage: string | null;
  taskPlan: RunDetail["taskPlan"];
  turn: RunDetail["turns"][number] | null;
  pendingBatch: NonNullable<RunDetail["questionBatches"][number]> | null;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const previewTaskPlan =
    role === "referee" && liveTurn?.phase === "planning"
      ? parseTaskPlanPreview(liveTurn.content)
      : null;
  const displayTurn = liveTurn ?? turn;
  const refereeDecision =
    displayTurn && role === "referee" && displayTurn.phase === "referee"
      ? parseRefereeDecision(displayTurn.content) ?? latestDecision
      : null;
  const finalConsensusPreview =
    displayTurn && role === "referee" && displayTurn.phase === "final"
      ? parseFinalConsensusPreview(displayTurn.content)
      : null;
  const activity = buildActivityState({
    liveTurn,
    now,
    runStatus,
  });
  const hasLiveContent = !!liveTurn && liveTurn.content.trim().length > 0;

  return (
    <section className="panel rounded-[2rem] p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow">{roleLabel}</p>
          <h2 className="mt-1 text-xl font-semibold">{modelId}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="status-pill rounded-full px-3 py-1 text-xs">
            <span className="inline-flex items-center gap-2">
              {activity.isActive ? (
                <span className="thinking-indicator" aria-hidden="true">
                  <span className="thinking-orb" />
                  <span className="thinking-orb" />
                  <span className="thinking-orb" />
                </span>
              ) : null}
              <span>
                {activity.attemptDetail
                  ? `${activity.detail}, ${activity.attemptDetail}`
                  : activity.detail}
              </span>
            </span>
          </span>
          {activity.retryDelayLabel ? (
            <span className="status-pill rounded-full px-3 py-1 text-xs">
              {activity.retryDelayLabel}
            </span>
          ) : null}
          {displayTurn?.phase ? (
            <span className="status-pill rounded-full px-3 py-1 text-xs">
              {formatPhaseName(displayTurn.phase)}
            </span>
          ) : null}
        </div>
      </div>

      {role === "referee" ? (
        <RefereeMilestoneCard
          currentTaskIndex={currentTaskIndex}
          pendingBatch={pendingBatch}
          previewTaskPlan={previewTaskPlan}
          runStatus={runStatus}
          taskPlan={taskPlan}
        />
      ) : null}

      {statusMessage ? (
        <div className="mt-4 rounded-[1.1rem] border border-[var(--line)] bg-white/75 p-4 text-sm text-[var(--ink-soft)]">
          {statusMessage}
        </div>
      ) : null}
      {liveTurn?.lastError ? (
        <div className="mt-4 rounded-[1.1rem] border border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-800">
          Previous attempt failed: {liveTurn.lastError}
          {typeof liveTurn.retryDelayMs === "number"
            ? ` Retrying ${
                liveTurn.attempt && liveTurn.maxAttempts
                  ? `attempt ${liveTurn.attempt} of ${liveTurn.maxAttempts}`
                  : "shortly"
              }${
                liveTurn.retryDelayMs > 0
                  ? ` after ${Math.ceil(liveTurn.retryDelayMs / 1000)}s of backoff.`
                  : "."
              }`
            : ""}
        </div>
      ) : null}

      <div className="mt-4" ref={contentRef}>
        {refereeDecision ? (
          <RefereeDecisionCard decision={refereeDecision} compact />
        ) : finalConsensusPreview ? (
          <FinalConsensusPreviewCard preview={finalConsensusPreview} />
        ) : liveTurn && !hasLiveContent ? (
          <ThinkingState
            detail={activity.detail}
            phase={liveTurn.phase}
            roleLabel={roleLabel}
            stateLabel={activity.label}
          />
        ) : displayTurn ? (
          role === "referee" && displayTurn.phase === "planning" && !previewTaskPlan ? (
            <pre className="mono overflow-x-auto rounded-[1rem] bg-[rgba(17,34,29,0.06)] p-4 text-xs whitespace-pre-wrap">
              {displayTurn.content || "Planning milestone list..."}
            </pre>
          ) : role === "referee" ? (
            <pre className="mono overflow-x-auto rounded-[1rem] bg-[rgba(17,34,29,0.06)] p-4 text-xs whitespace-pre-wrap">
              {displayTurn.content || "Waiting for referee output..."}
            </pre>
          ) : (
            <div className="max-h-[34rem] overflow-auto rounded-[1rem] bg-white/75 p-4">
              <MarkdownBlock content={displayTurn.content || "Waiting for first tokens..."} />
            </div>
          )
        ) : (
          <div className="rounded-[1rem] border border-dashed border-[var(--line)] px-4 py-6 text-sm text-[var(--ink-soft)]">
            No visible activity yet.
          </div>
        )}
      </div>

      {role !== "referee" ? (
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          <div className="rounded-[1.1rem] border border-[var(--line)] bg-white/75 p-4">
            <div className="eyebrow">Evidence gathered here</div>
            <div className="mt-2 text-sm font-medium text-[var(--ink-soft)]">
              Cycle {currentMilestoneTurn + 1} of {maxMilestoneTurns}
            </div>
            {evidenceSources.length ? (
              <ul className="mt-3 space-y-2 text-sm leading-6 text-[var(--foreground)]">
                {evidenceSources.slice(0, 4).map((source) => (
                  <li key={source.id}>{source.title}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm leading-6 text-[var(--ink-soft)]">
                No structured sources gathered on this visible turn.
              </p>
            )}
          </div>
          <div className="rounded-[1.1rem] border border-[var(--line)] bg-white/75 p-4">
            <div className="eyebrow">
              {sharedEvidenceLabel ? `Shared evidence from ${sharedEvidenceLabel}` : "Shared evidence"}
            </div>
            {sharedEvidenceSources.length ? (
              <ul className="mt-3 space-y-2 text-sm leading-6 text-[var(--foreground)]">
                {sharedEvidenceSources.slice(0, 4).map((source) => (
                  <li key={source.id}>{source.title}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm leading-6 text-[var(--ink-soft)]">
                No handoff evidence is visible for this milestone yet.
              </p>
            )}
          </div>
        </div>
      ) : null}

      {displayTurn ? (
        <div className="mt-4">
          <CopyButtons
            raw={displayTurn.content}
            getHtml={() => contentRef.current?.innerHTML ?? ""}
          />
        </div>
      ) : null}
    </section>
  );
}

function TranscriptCard({
  createdAt,
  content,
  isLive,
  modelId,
  phase,
  refereeDecision,
  role,
  roleLabel,
  runStatus,
  sources,
}: {
  createdAt: string;
  content: string;
  isLive: boolean;
  modelId: string;
  phase: TurnPhase;
  refereeDecision?: RefereeDecisionViewModel | null;
  role: ActorRole;
  roleLabel: string;
  runStatus: RunDetail["status"];
  sources?: SourceRecord[];
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const finalConsensusPreview =
    role === "referee" && phase === "final" ? parseFinalConsensusPreview(content) : null;

  return (
    <article
      className={
        isLive
          ? "rounded-[1.5rem] border border-[var(--accent)] bg-[rgba(196,74,39,0.08)] p-5"
          : "rounded-[1.5rem] border border-[var(--line)] bg-white/65 p-5"
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="status-pill rounded-full px-3 py-1 text-xs">{roleLabel}</span>
          <span className="status-pill rounded-full px-3 py-1 text-xs">{phase}</span>
          {isLive ? (
            <span className="status-pill rounded-full px-3 py-1 text-xs">
              {["queued", "running", "waiting_for_user"].includes(runStatus)
                ? "streaming"
                : "captured"}
            </span>
          ) : null}
          <span className="mono text-xs text-[var(--ink-soft)]">{modelId}</span>
        </div>
        <span className="mono text-xs text-[var(--ink-soft)]">
          {new Date(createdAt).toLocaleTimeString()}
        </span>
      </div>

      <div ref={contentRef}>
        {refereeDecision ? (
          <RefereeDecisionCard decision={refereeDecision} />
        ) : finalConsensusPreview ? (
          <FinalConsensusPreviewCard preview={finalConsensusPreview} />
        ) : role === "referee" && (phase === "referee" || phase === "planning") ? (
          <pre className="mono mt-4 overflow-x-auto rounded-[1rem] bg-[rgba(17,34,29,0.06)] p-4 text-xs whitespace-pre-wrap">
            {content || "Waiting for referee decision..."}
          </pre>
        ) : (
          <div className="mt-4">
            <MarkdownBlock content={content || "Waiting for first tokens..."} />
          </div>
        )}
      </div>

      <div className="mt-4">
        <CopyButtons raw={content} getHtml={() => contentRef.current?.innerHTML ?? ""} />
      </div>

      {!refereeDecision && !finalConsensusPreview && sources?.length ? (
        <div className="mt-5 rounded-[1.2rem] border border-[var(--line)] bg-white/75 p-4">
          <h3 className="text-sm font-semibold">Sources</h3>
          <ul className="mt-3 space-y-2 text-sm">
            {sources.map((source) => (
              <li key={source.id}>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-[var(--accent)] underline-offset-4"
                >
                  {source.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

export function RunSession({ initialRun }: RunSessionProps) {
  const [run, setRun] = useState(initialRun);
  const [error, setError] = useState<string | null>(null);
  const [liveTurns, setLiveTurns] = useState<Record<string, LiveTurn>>(
    toLiveTurnMap(initialRun.liveState?.activeTurns),
  );
  const [statusMessage, setStatusMessage] = useState<string | null>(
    initialRun.liveState?.latestStatusMessage ?? null,
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [now, setNow] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();

  const pendingBatch =
    run.questionBatches.find(
      (batch) => batch.id === run.activeQuestionBatchId && batch.status === "pending",
    ) ?? null;
  const roleLabels = getRoleLabels(run);

  useEffect(() => {
    setStepIndex(0);
  }, [pendingBatch?.id]);

  useEffect(() => {
    setLiveTurns({});
    setStatusMessage(null);
  }, [run.id]);

  useEffect(() => {
    setLiveTurns(toLiveTurnMap(run.liveState?.activeTurns));
    setStatusMessage(run.liveState?.latestStatusMessage ?? null);
  }, [
    run.id,
    run.liveState?.activeTurns,
    run.liveState?.updatedAt,
    run.liveState?.latestStatusMessage,
  ]);

  useEffect(() => {
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const upsertLiveTurn = useEffectEvent(
    (payload: {
      at: string;
      attempt?: number;
      content: string;
      lastError?: string | null;
      maxAttempts?: number;
      modelId: string;
      phase: TurnPhase;
      retryDelayMs?: number | null;
      role: ActorRole;
      startedAt?: string;
      turnIndex: number;
      updatedAt: string;
    }) => {
      const key = liveTurnKey(payload.role, payload.phase, payload.turnIndex);

      setLiveTurns((existing) => ({
        ...existing,
        [key]: {
          attempt: payload.attempt,
          content: payload.content,
          lastError: payload.lastError ?? null,
          maxAttempts: payload.maxAttempts,
          modelId: payload.modelId,
          phase: payload.phase,
          retryDelayMs: payload.retryDelayMs ?? null,
          role: payload.role,
          startedAt: payload.startedAt ?? existing[key]?.startedAt ?? payload.at,
          turnIndex: payload.turnIndex,
          updatedAt: payload.updatedAt,
        },
      }));
    },
  );

  const clearLiveTurn = useEffectEvent(
    (payload: { phase: TurnPhase; role: ActorRole; turnIndex: number }) => {
      const key = liveTurnKey(payload.role, payload.phase, payload.turnIndex);

      setLiveTurns((existing) => {
        if (!existing[key]) {
          return existing;
        }

        const next = { ...existing };
        delete next[key];
        return next;
      });
    },
  );

  useEffect(() => {
    if (!["queued", "running", "waiting_for_user"].includes(run.status)) {
      return;
    }

    const source = new EventSource(`/api/runs/${run.id}/stream`);
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as RunEvent | { type?: string; at?: string };

      if (payload.type === "connected" || payload.type === "heartbeat") {
        return;
      }

      if (payload.type === "status") {
        const statusEvent = payload as Extract<RunEvent, { type: "status" }>;
        setStatusMessage(statusEvent.message ?? null);
      }

      if (payload.type === "turn_started") {
        const startedEvent = payload as Extract<RunEvent, { type: "turn_started" }>;
        upsertLiveTurn({
          at: startedEvent.at,
          attempt: startedEvent.attempt,
          content: "",
          lastError: null,
          maxAttempts: startedEvent.maxAttempts,
          modelId: startedEvent.modelId,
          phase: startedEvent.phase,
          retryDelayMs: null,
          role: startedEvent.role,
          startedAt: startedEvent.at,
          turnIndex: startedEvent.turnIndex,
          updatedAt: startedEvent.at,
        });
        return;
      }

      if (payload.type === "turn_retrying") {
        const retryEvent = payload as Extract<RunEvent, { type: "turn_retrying" }>;
        upsertLiveTurn({
          at: retryEvent.at,
          attempt: retryEvent.attempt,
          content: "",
          lastError: retryEvent.lastError,
          maxAttempts: retryEvent.maxAttempts,
          modelId: retryEvent.modelId,
          phase: retryEvent.phase,
          retryDelayMs: retryEvent.retryDelayMs,
          role: retryEvent.role,
          startedAt: retryEvent.at,
          turnIndex: retryEvent.turnIndex,
          updatedAt: retryEvent.at,
        });
        return;
      }

      if (payload.type === "turn_delta") {
        const deltaEvent = payload as Extract<RunEvent, { type: "turn_delta" }>;
        upsertLiveTurn({
          at: deltaEvent.at,
          attempt: deltaEvent.attempt,
          content: deltaEvent.content,
          lastError: null,
          maxAttempts: deltaEvent.maxAttempts,
          modelId: deltaEvent.modelId,
          phase: deltaEvent.phase,
          retryDelayMs: null,
          role: deltaEvent.role,
          turnIndex: deltaEvent.turnIndex,
          updatedAt: deltaEvent.at,
        });
        return;
      }

      if (payload.type === "turn_completed") {
        const completedEvent = payload as Extract<RunEvent, { type: "turn_completed" }>;
        clearLiveTurn({
          phase: completedEvent.turn.phase,
          role: completedEvent.turn.role,
          turnIndex: completedEvent.turn.turnIndex,
        });
      }

      void fetchRun(run.id)
        .then((nextRun) => setRun(nextRun))
        .catch((fetchError) => {
          setError(
            fetchError instanceof Error
              ? fetchError.message
              : "Could not refresh run state.",
          );
        });
    };

    source.onerror = () => {
      source.close();
    };

    return () => source.close();
  }, [run.id, run.status]);

  const sourcesByTurn = groupSourcesByTurn(run);
  const refereeDecisionsByTurn = new Map(
    run.refereeDecisions.map((decision) => [
      decision.turnIndex,
      toRefereeDecisionViewModel(decision),
    ]),
  );
  const latestDecision = run.refereeDecisions.at(-1)
    ? toRefereeDecisionViewModel(run.refereeDecisions.at(-1)!)
    : null;
  const transcriptTurns = [...run.turns].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  const activeTurnKeys = new Set(
    transcriptTurns.map((turn) => liveTurnKey(turn.role, turn.phase, turn.turnIndex)),
  );
  const transcriptItems = [
    ...transcriptTurns.map((turn) => ({
      createdAt: turn.createdAt,
      kind: "persisted" as const,
      turn,
    })),
    ...Object.values(liveTurns)
      .filter((turn) => !activeTurnKeys.has(liveTurnKey(turn.role, turn.phase, turn.turnIndex)))
      .map((turn) => ({
        createdAt: turn.startedAt,
        kind: "live" as const,
        turn,
      })),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const participantALiveTurn = latestLiveTurn(liveTurns, "participant_a");
  const participantBLiveTurn = latestLiveTurn(liveTurns, "participant_b");
  const refereeLiveTurn = latestLiveTurn(liveTurns, "referee");
  const planningPreviewTaskPlan =
    refereeLiveTurn?.phase === "planning"
      ? parseTaskPlanPreview(refereeLiveTurn.content)
      : null;
  const displayTaskPlan =
    run.taskPlan.length > 0 ? run.taskPlan : planningPreviewTaskPlan ?? [];
  const latestParticipantATurn = latestPersistedTurn(run.turns, "participant_a");
  const latestParticipantBTurn = latestPersistedTurn(run.turns, "participant_b");
  const latestRefereeTurn = latestPersistedTurn(run.turns, "referee");
  const participantAEvidenceTurn = latestEvidenceTurnForRole({
    role: "participant_a",
    run,
    sourcesByTurn,
  });
  const participantBEvidenceTurn = latestEvidenceTurnForRole({
    role: "participant_b",
    run,
    sourcesByTurn,
  });
  const participantAEvidenceSources = participantAEvidenceTurn
    ? sourcesByTurn.get(participantAEvidenceTurn.id) ?? []
    : [];
  const participantBEvidenceSources = participantBEvidenceTurn
    ? sourcesByTurn.get(participantBEvidenceTurn.id) ?? []
    : [];
  const participantAStats = countParticipantOutputs(run.turns, "participant_a");
  const participantBStats = countParticipantOutputs(run.turns, "participant_b");
  const refereeStats = countRefereeOutputs(run.turns);
  const participantAOutputLabels = getDebateOutputLabels(run.debateMode, "participant_a");
  const participantBOutputLabels = getDebateOutputLabels(run.debateMode, "participant_b");
  const refereeOutputLabels = getDebateOutputLabels(run.debateMode, "referee");

  async function cancelRun() {
    setError(null);
    try {
      const response = await fetch(`/api/runs/${run.id}/cancel`, { method: "POST" });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Run cancellation failed.");
      }

      setRun(await fetchRun(run.id));
    } catch (cancelError) {
      setError(
        cancelError instanceof Error ? cancelError.message : "Run cancellation failed.",
      );
    }
  }

  function retryRun() {
    setError(null);
    setLiveTurns({});

    startTransition(() => {
      void fetch(`/api/runs/${run.id}/retry`, { method: "POST" })
        .then(async (response) => {
          const payload = (await response.json()) as { error?: string; run?: RunDetail };
          if (!response.ok || !payload.run) {
            throw new Error(payload.error ?? "Run retry failed.");
          }

          setRun(payload.run);
        })
        .catch((retryError) => {
          setError(retryError instanceof Error ? retryError.message : "Run retry failed.");
        });
    });
  }

  function submitAnswers(answers: UserQuestionAnswer[]) {
    if (!pendingBatch) {
      return;
    }

    startTransition(() => {
      void fetch(`/api/runs/${run.id}/question-batches/${pendingBatch.id}/answers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ answers }),
      })
        .then(async (response) => {
          const payload = (await response.json()) as { error?: string };
          if (!response.ok) {
            throw new Error(payload.error ?? "Could not submit answers.");
          }

          setRun(await fetchRun(run.id));
        })
        .catch((submitError) => {
          setError(
            submitError instanceof Error
              ? submitError.message
              : "Could not submit answers.",
          );
        });
    });
  }

  return (
    <div className="app-shell grid-lines">
      <div className="flex w-full flex-1 flex-col gap-8 px-6 py-8 lg:px-10">
        <header className="grid gap-5 lg:grid-cols-[1.4fr_0.9fr]">
          <section className="panel rounded-[2rem] p-8">
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/" className="eyebrow">
                Back to builder
              </Link>
              <span className="status-pill rounded-full px-4 py-2 text-sm">
                {run.status}
              </span>
              <span className="status-pill rounded-full px-4 py-2 text-sm">
                {getDebateModeLabel(run.debateMode)}
              </span>
              {run.stopReason ? (
                <span className="status-pill rounded-full px-4 py-2 text-sm">
                  stop: {run.stopReason}
                </span>
              ) : null}
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight md:text-5xl">
              Debate transcript
            </h1>
            <p className="mt-4 text-base leading-7 text-[var(--ink-soft)]">
              Live milestone state first, then prompt details and history when you need them.
            </p>
            <div className="mt-6 grid gap-3 text-sm text-[var(--ink-soft)] md:grid-cols-3">
              <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/55 p-4">
                <div className="eyebrow">Active roles</div>
                <div className="mt-2 leading-7">
                  {roleLabels.participant_a}: {run.participantA.modelId}
                  <br />
                  {roleLabels.participant_b}: {run.participantB.modelId}
                </div>
              </div>
              <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/55 p-4">
                <div className="eyebrow">{roleLabels.referee}</div>
                <div className="mt-2 leading-7">{run.referee.modelId}</div>
              </div>
              <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/55 p-4">
                <div className="eyebrow">Tool surface</div>
                <div className="mt-2 leading-7">
                  Search: {run.searchBackend}
                  <br />
                  Workspace: {run.workspacePath ? run.workspacePath : "off"}
                </div>
              </div>
            </div>
          </section>

          <aside className="panel rounded-[2rem] p-8">
            <p className="eyebrow">Controls</p>
            <div className="mt-5 space-y-5">
              <div>
                <div className="text-sm text-[var(--ink-soft)]">Current cycle</div>
                <div className="mt-1 text-3xl font-semibold">{run.currentTurn + 1}</div>
              </div>
              <div>
                <div className="text-sm text-[var(--ink-soft)]">Milestone cycle</div>
                <div className="mt-1 text-3xl font-semibold">
                  {run.currentMilestoneTurn + 1}
                  <span className="ml-2 text-sm font-medium text-[var(--ink-soft)]">
                    of {run.maxTurns}
                  </span>
                </div>
              </div>
              <div>
                <div className="text-sm text-[var(--ink-soft)]">Max cycles per milestone</div>
                <div className="mt-1 text-3xl font-semibold">{run.maxTurns}</div>
              </div>
            </div>

            {["queued", "running", "waiting_for_user"].includes(run.status) ? (
              <button
                type="button"
                onClick={cancelRun}
                className="mt-8 w-full rounded-full border border-[var(--foreground)] px-5 py-3 text-sm font-medium transition hover:bg-[var(--foreground)] hover:text-[var(--background)]"
              >
                Cancel run
              </button>
            ) : null}
            {run.status === "failed" ? (
              <button
                type="button"
                onClick={retryRun}
                disabled={isPending}
                className="mt-4 w-full rounded-full bg-[var(--accent)] px-5 py-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {isPending ? "Retrying..." : "Retry from failure"}
              </button>
            ) : null}
            {run.status === "failed" && run.errorText ? (
              <div className="mt-4 rounded-[1.2rem] border border-red-200 bg-red-50/80 px-4 py-3 text-sm text-red-700">
                {run.errorText}
              </div>
            ) : null}
            {error ? (
              <div className="mt-4 rounded-[1.2rem] border border-red-200 bg-red-50/80 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            ) : null}
          </aside>
        </header>

        {pendingBatch ? (
          <QuestionBatchPanel
            key={pendingBatch.id}
            batch={pendingBatch}
            stepIndex={stepIndex}
            setStepIndex={setStepIndex}
            onSubmit={submitAnswers}
            isPending={isPending}
          />
        ) : null}

        <section className="grid gap-6 xl:grid-cols-5">
          <MilestoneOverviewCard
            currentTaskIndex={run.currentTaskIndex}
            currentMilestoneTurn={run.currentMilestoneTurn}
            maxMilestoneTurns={run.maxTurns}
            pendingBatch={pendingBatch}
            runStatus={run.status}
            taskPlan={displayTaskPlan}
          />
          <RoleSummaryCard
            breakdown={participantAStats.total}
            liveTurn={participantALiveTurn}
            modelId={run.participantA.modelId}
            now={now}
            primaryLabel={participantAOutputLabels.primary}
            primaryValue={participantAStats.proposalLike}
            roleLabel={roleLabels.participant_a}
            roleTestId="participant_a"
            runStatus={run.status}
            secondaryLabel={participantAOutputLabels.secondary}
            secondaryValue={participantAStats.critiques}
          />
          <RoleSummaryCard
            breakdown={participantBStats.total}
            liveTurn={participantBLiveTurn}
            modelId={run.participantB.modelId}
            now={now}
            primaryLabel={participantBOutputLabels.primary}
            primaryValue={participantBStats.proposalLike}
            roleLabel={roleLabels.participant_b}
            roleTestId="participant_b"
            runStatus={run.status}
            secondaryLabel={participantBOutputLabels.secondary}
            secondaryValue={participantBStats.critiques}
          />
          <RoleSummaryCard
            breakdown={refereeStats.total}
            liveTurn={refereeLiveTurn}
            modelId={run.referee.modelId}
            now={now}
            primaryLabel={refereeOutputLabels.primary}
            primaryValue={refereeStats.planning}
            roleLabel={roleLabels.referee}
            roleTestId="referee"
            runStatus={run.status}
            secondaryLabel={refereeOutputLabels.secondary}
            secondaryValue={refereeStats.evaluations}
          />
        </section>

        <section className="grid gap-6 xl:grid-cols-3">
          <LiveRolePanel
            currentTaskIndex={run.currentTaskIndex}
            currentMilestoneTurn={run.currentMilestoneTurn}
            evidenceSources={participantAEvidenceSources}
            latestDecision={latestDecision}
            liveTurn={participantALiveTurn}
            maxMilestoneTurns={run.maxTurns}
            modelId={run.participantA.modelId}
            now={now}
            role="participant_a"
            roleLabel={roleLabels.participant_a}
            runStatus={run.status}
            sharedEvidenceLabel={roleLabels.participant_b}
            sharedEvidenceSources={participantBEvidenceSources}
            statusMessage={null}
            taskPlan={displayTaskPlan}
            turn={latestParticipantATurn}
            pendingBatch={pendingBatch}
          />
          <LiveRolePanel
            currentTaskIndex={run.currentTaskIndex}
            currentMilestoneTurn={run.currentMilestoneTurn}
            evidenceSources={participantBEvidenceSources}
            latestDecision={latestDecision}
            liveTurn={participantBLiveTurn}
            maxMilestoneTurns={run.maxTurns}
            modelId={run.participantB.modelId}
            now={now}
            role="participant_b"
            roleLabel={roleLabels.participant_b}
            runStatus={run.status}
            sharedEvidenceLabel={roleLabels.participant_a}
            sharedEvidenceSources={participantAEvidenceSources}
            statusMessage={null}
            taskPlan={displayTaskPlan}
            turn={latestParticipantBTurn}
            pendingBatch={pendingBatch}
          />
          <LiveRolePanel
            currentTaskIndex={run.currentTaskIndex}
            currentMilestoneTurn={run.currentMilestoneTurn}
            evidenceSources={[]}
            latestDecision={latestDecision}
            liveTurn={refereeLiveTurn}
            maxMilestoneTurns={run.maxTurns}
            modelId={run.referee.modelId}
            now={now}
            role="referee"
            roleLabel={roleLabels.referee}
            runStatus={run.status}
            sharedEvidenceSources={[]}
            statusMessage={statusMessage}
            taskPlan={displayTaskPlan}
            turn={latestRefereeTurn}
            pendingBatch={pendingBatch}
          />
        </section>

        <PromptCard prompt={run.taskPrompt} />

        {latestDecision ? (
          <CollapsiblePanel
            defaultOpen={run.status === "completed" || run.status === "failed"}
            eyebrow="Referee"
            summaryText={latestDecision.summary}
            title="Latest referee call"
          >
            <RefereeDecisionCard decision={latestDecision} compact />
          </CollapsiblePanel>
        ) : null}

        {run.finalConsensus ? (
          <section className="panel panel-strong rounded-[2rem] p-8">
            <p className="eyebrow">Consensus output</p>
            <div className="mt-5 grid gap-8 lg:grid-cols-[1.3fr_0.85fr]">
              <article className="rounded-[1.5rem] border border-[var(--line)] bg-white/70 p-6">
                <h2 className="text-2xl font-semibold">Solution</h2>
                <div className="mt-4">
                  <MarkdownBlock content={run.finalConsensus.solution} />
                </div>
                <h3 className="mt-8 text-xl font-semibold">Rationale</h3>
                <div className="mt-4 text-[var(--ink-soft)]">
                  <MarkdownBlock content={run.finalConsensus.rationale} />
                </div>
              </article>
              <aside className="rounded-[1.5rem] border border-[var(--line)] bg-white/70 p-6">
                <h2 className="text-xl font-semibold">Sources</h2>
                <ol className="mt-4 space-y-3 text-sm leading-6">
                  {run.finalConsensus.sources.map((source, index) => (
                    <li
                      key={`${source.url}-${index}`}
                      className="rounded-[1rem] border border-[var(--line)] bg-white/80 p-3"
                    >
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium underline decoration-[var(--accent)] underline-offset-4"
                      >
                        {index + 1}. {source.title}
                      </a>
                      <div className="mt-1 text-[var(--ink-soft)]">{source.url}</div>
                      {source.snippet ? (
                        <p className="mt-2 text-[var(--ink-soft)]">{source.snippet}</p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </aside>
            </div>
          </section>
        ) : null}

        <div className="grid gap-8 lg:grid-cols-[1.35fr_0.85fr]">
          <CollapsiblePanel
            defaultOpen={!isActiveRunStatus(run.status)}
            eyebrow="Transcript"
            summaryText={`${transcriptItems.length} captured turns. Keep this folded while watching the live lanes.`}
            title="Turn history"
          >
            <div className="space-y-5">
              {transcriptItems.map((item) => {
                const persistedDecision =
                  item.kind === "persisted" &&
                  item.turn.role === "referee" &&
                  item.turn.phase === "referee"
                    ? refereeDecisionsByTurn.get(item.turn.turnIndex) ??
                      parseRefereeDecision(item.turn.content)
                    : null;
                const liveDecision =
                  item.kind === "live" &&
                  item.turn.role === "referee" &&
                  item.turn.phase === "referee"
                    ? parseRefereeDecision(item.turn.content)
                    : null;

                return (
                  <TranscriptCard
                    key={
                      item.kind === "persisted"
                        ? item.turn.id
                        : liveTurnKey(item.turn.role, item.turn.phase, item.turn.turnIndex)
                    }
                    createdAt={item.createdAt}
                    content={item.turn.content}
                    isLive={item.kind === "live"}
                    modelId={item.turn.modelId}
                    phase={item.turn.phase}
                    refereeDecision={item.kind === "persisted" ? persistedDecision : liveDecision}
                    role={item.turn.role}
                    roleLabel={roleLabels[item.turn.role]}
                    runStatus={run.status}
                    sources={
                      item.kind === "persisted"
                        ? (sourcesByTurn.get(item.turn.id) ?? [])
                        : []
                    }
                  />
                );
              })}
            </div>
          </CollapsiblePanel>

          <CollapsiblePanel
            eyebrow="Diagnostics"
            summaryText={`${run.toolInvocations.length} tool calls, ${run.questionBatches.length} question batches.`}
            title="Tool activity and clarifications"
          >
            <div>
              <p className="eyebrow">Tool activity</p>
              <h3 className="mt-2 text-xl font-semibold">Observed calls</h3>
            </div>
            <div className="mt-6 space-y-4">
              {run.toolInvocations.length === 0 ? (
                <div className="rounded-[1.4rem] border border-dashed border-[var(--line)] px-4 py-5 text-sm text-[var(--ink-soft)]">
                  No tool calls yet.
                </div>
              ) : (
                run.toolInvocations.map((tool) => (
                  <article
                    key={tool.id}
                    className="rounded-[1.2rem] border border-[var(--line)] bg-white/65 p-4"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="status-pill rounded-full px-3 py-1 text-xs">
                        {tool.toolName}
                      </span>
                      <span className="mono text-xs text-[var(--ink-soft)]">
                        {tool.role}
                      </span>
                    </div>
                    <pre className="mono mt-3 overflow-x-auto rounded-[1rem] bg-[rgba(17,34,29,0.06)] p-3 text-xs">
                      {tool.inputJson}
                    </pre>
                    {tool.status === "error" ? (
                      <p className="mt-3 text-sm text-red-700">{tool.errorMessage}</p>
                    ) : null}
                  </article>
                ))
              )}
            </div>

            <div className="mt-8">
              <p className="eyebrow">Question batches</p>
              <div className="mt-4 space-y-4">
                {run.questionBatches.length === 0 ? (
                  <div className="rounded-[1.4rem] border border-dashed border-[var(--line)] px-4 py-5 text-sm text-[var(--ink-soft)]">
                    The referee has not requested clarification.
                  </div>
                ) : (
                  run.questionBatches.map((batch) => (
                    <div
                      key={batch.id}
                      className="rounded-[1.2rem] border border-[var(--line)] bg-white/65 p-4 text-sm"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="status-pill rounded-full px-3 py-1 text-xs">
                          {batch.status}
                        </span>
                        <span className="mono text-xs text-[var(--ink-soft)]">
                          {new Date(batch.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <ol className="mt-3 space-y-2 text-[var(--ink-soft)]">
                        {batch.questions.map((question) => (
                          <li key={question.id}>{question.question}</li>
                        ))}
                      </ol>
                    </div>
                  ))
                )}
              </div>
            </div>
          </CollapsiblePanel>
        </div>
      </div>
    </div>
  );
}

function QuestionBatchPanel({
  batch,
  stepIndex,
  setStepIndex,
  onSubmit,
  isPending,
}: {
  batch: NonNullable<RunDetail["questionBatches"][number]>;
  stepIndex: number;
  setStepIndex: (value: number) => void;
  onSubmit: (answers: UserQuestionAnswer[]) => void;
  isPending: boolean;
}) {
  const [answers, setAnswers] = useState<UserQuestionAnswer[]>(
    batch.questions.map((question) => ({
      questionId: question.id,
      selectedOptionId: null,
      note: "",
    })),
  );

  const currentQuestion = batch.questions[stepIndex];
  const currentAnswer = answers[stepIndex];

  return (
    <section className="panel panel-strong rounded-[2rem] p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="eyebrow">Referee clarification</p>
          <h2 className="mt-2 text-2xl font-semibold">
            The run is paused until this batch is answered
          </h2>
        </div>
        <span className="status-pill rounded-full px-4 py-2 text-sm">
          Question {stepIndex + 1} of {batch.questions.length}
        </span>
      </div>

      <div className="mt-6 rounded-[1.6rem] border border-[var(--line)] bg-white/75 p-6">
        <h3 className="text-2xl font-semibold">{currentQuestion.question}</h3>
        <div className="mt-5 grid gap-3">
          {currentQuestion.options.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer flex-col gap-2 rounded-[1.2rem] border border-[var(--line)] bg-white/80 p-4"
            >
              <div className="flex items-center gap-3">
                <input
                  type="radio"
                  name={currentQuestion.id}
                  checked={currentAnswer?.selectedOptionId === option.id}
                  onChange={() =>
                    setAnswers((existing) =>
                      existing.map((answer, index) =>
                        index === stepIndex
                          ? { ...answer, selectedOptionId: option.id }
                          : answer,
                      ),
                    )
                  }
                />
                <span className="font-medium">{option.label}</span>
                {option.recommended ? (
                  <span className="status-pill rounded-full px-3 py-1 text-xs">
                    recommended
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-[var(--ink-soft)]">{option.description}</p>
            </label>
          ))}
        </div>

        <label className="mt-5 grid gap-2">
          <span className="text-sm font-medium">Optional note</span>
          <textarea
            className="min-h-28 rounded-[1rem] border border-[var(--line)] bg-white/80 px-4 py-3 outline-none transition focus:border-[var(--accent)]"
            placeholder={
              currentQuestion.notePlaceholder ??
              "Add optional detail, context, or constraints."
            }
            value={currentAnswer?.note ?? ""}
            onChange={(event) =>
              setAnswers((existing) =>
                existing.map((answer, index) =>
                  index === stepIndex ? { ...answer, note: event.target.value } : answer,
                ),
              )
            }
          />
        </label>
      </div>

      <div className="mt-6 flex items-center justify-between gap-4">
        <button
          type="button"
          className="rounded-full border border-[var(--line)] px-5 py-3 text-sm"
          onClick={() => setStepIndex(Math.max(0, stepIndex - 1))}
          disabled={stepIndex === 0}
        >
          Previous
        </button>

        {stepIndex < batch.questions.length - 1 ? (
          <button
            type="button"
            className="rounded-full bg-[var(--foreground)] px-5 py-3 text-sm font-medium text-[var(--background)]"
            onClick={() => setStepIndex(stepIndex + 1)}
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            className="rounded-full bg-[var(--accent)] px-5 py-3 text-sm font-medium text-white disabled:opacity-50"
            onClick={() => onSubmit(answers)}
            disabled={isPending}
          >
            {isPending ? "Submitting..." : "Resume run"}
          </button>
        )}
      </div>
    </section>
  );
}
