import type {
  DebateTask,
  ParticipantRole,
  RefereeDecision,
  TurnRecord,
  UserQuestionBatch,
  UserQuestionProposal,
  WorkspaceManifest,
} from "@/lib/types";

function formatWorkspaceManifest(manifest?: WorkspaceManifest | null) {
  if (!manifest) {
    return "No workspace tools are enabled for this run.";
  }

  const commands = manifest.commands.length
    ? manifest.commands.map((command) => `- ${command.id}: ${command.label}`).join("\n")
    : "- No workspace checks were discovered.";

  return [
    `Workspace root: ${manifest.rootPath}`,
    "Available workspace checks:",
    commands,
  ].join("\n");
}

function formatQuestionBatches(answeredQuestionBatches: UserQuestionBatch[]) {
  if (answeredQuestionBatches.length === 0) {
    return "No user clarifications have been answered yet.";
  }

  return answeredQuestionBatches
    .map((batch) => {
      const answers = (batch.answers ?? [])
        .map((answer) => {
          const note = answer.note ? ` | note: ${answer.note}` : "";
          return `- ${answer.questionId}: ${answer.selectedOptionId ?? "skipped"}${note}`;
        })
        .join("\n");
      return `Batch ${batch.id}:\n${answers}`;
    })
    .join("\n\n");
}

function formatQuestionProposals(
  questionProposals: Array<{
    role: ParticipantRole;
    proposals: UserQuestionProposal[];
  }>,
) {
  if (questionProposals.every((entry) => entry.proposals.length === 0)) {
    return "No participant question proposals were submitted this round.";
  }

  return questionProposals
    .map((entry) => {
      const proposals = entry.proposals
        .map((proposal) => {
          const options = proposal.options
            .map(
              (option) =>
                `    - ${option.id}: ${option.label} (${option.description})${option.recommended ? " [recommended]" : ""}`,
            )
            .join("\n");
          return `  - ${proposal.question}\n${options}`;
        })
        .join("\n");

      return `${entry.role}:\n${proposals}`;
    })
    .join("\n\n");
}

function formatTaskPlan(taskPlan: DebateTask[], currentTaskIndex: number) {
  if (taskPlan.length === 0) {
    return "No milestone plan has been generated yet.";
  }

  return taskPlan
    .map((task, index) => {
      const status =
        index < currentTaskIndex
          ? "completed"
          : index === currentTaskIndex
            ? "current"
            : "pending";
      return [
        `${index + 1}. [${status}] ${task.title}`,
        `   Objective: ${task.objective}`,
        `   Completion: ${task.completionCriteria}`,
      ].join("\n");
    })
    .join("\n");
}

function formatCurrentTask(taskPlan: DebateTask[], currentTaskIndex: number) {
  const currentTask = taskPlan[currentTaskIndex];
  if (!currentTask) {
    return "No current task is available.";
  }

  return [
    `Title: ${currentTask.title}`,
    `Objective: ${currentTask.objective}`,
    `Completion criteria: ${currentTask.completionCriteria}`,
  ].join("\n");
}

export function buildParticipantSystemPrompt(
  role: ParticipantRole,
  persona: string | undefined,
  manifest?: WorkspaceManifest | null,
) {
  const roleName = role === "participant_a" ? "Participant A" : "Participant B";

  return [
    `You are ${roleName} in a structured multi-model collaboration.`,
    "Your job is to produce the strongest possible answer while directly engaging with the other participant's ideas.",
    "Use tools when they materially improve the answer. Prefer evidence over unsupported claims.",
    "If you need clarification from the user, do not ask directly. Use the propose_user_questions tool instead.",
    "Do not put raw URLs inline in the solution body.",
    persona ? `Persona override:\n${persona}` : "No persona override was supplied.",
    formatWorkspaceManifest(manifest),
  ].join("\n\n");
}

export function buildParticipantUserPrompt(args: {
  taskPrompt: string;
  taskPlan: DebateTask[];
  currentTaskIndex: number;
  turnIndex: number;
  phase: "proposal" | "revision";
  previousOwnTurn?: TurnRecord | null;
  previousOpponentTurn?: TurnRecord | null;
  previousOwnCritique?: TurnRecord | null;
  previousOpponentCritique?: TurnRecord | null;
  previousDecision?: RefereeDecision | null;
  answeredQuestionBatches: UserQuestionBatch[];
}) {
  const sections = [
    `Current milestone:\n${formatCurrentTask(args.taskPlan, args.currentTaskIndex)}`,
    `Milestone plan:\n${formatTaskPlan(args.taskPlan, args.currentTaskIndex)}`,
    `Full user request:\n${args.taskPrompt}`,
    `Current round: ${args.turnIndex + 1}`,
    args.phase === "proposal"
      ? "Produce an independent initial proposal focused on the current milestone only."
      : "Produce a revised proposal focused on the current milestone only. Use the referee guidance, the other participant's latest output, and the critique exchange from the last cycle.",
    args.previousOwnTurn
      ? `Your previous output:\n${args.previousOwnTurn.content}`
      : "You do not have a previous output yet for this workflow.",
    args.previousOpponentTurn
      ? `Other participant's latest output:\n${args.previousOpponentTurn.content}`
      : "The other participant does not have a previous output yet.",
    args.previousOwnCritique
      ? `Your last critique of the other participant:\n${args.previousOwnCritique.content}`
      : "You have not critiqued the other participant yet.",
    args.previousOpponentCritique
      ? `Latest critique of your output from the other participant:\n${args.previousOpponentCritique.content}`
      : "You have not received direct critique from the other participant yet.",
    args.previousDecision
      ? `Referee guidance:\nSummary: ${args.previousDecision.summary}\nPreferred draft: ${args.previousDecision.preferredDraft}\nRequired next focus: ${args.previousDecision.requiredNextFocus}\nRemaining disagreements: ${args.previousDecision.remainingDisagreements}`
      : "There is no referee guidance yet.",
    `Answered user clarifications:\n${formatQuestionBatches(args.answeredQuestionBatches)}`,
    "Stay on the current milestone. Do not skip ahead to later milestones unless the current milestone explicitly requires it.",
    "Respond in Markdown. Make the answer directly usable for the current milestone. Keep citations out of the body; the app will attach structured sources separately.",
  ];

  return sections.join("\n\n");
}

export function buildParticipantCritiqueUserPrompt(args: {
  taskPrompt: string;
  taskPlan: DebateTask[];
  currentTaskIndex: number;
  turnIndex: number;
  ownTurn: TurnRecord;
  opponentTurn: TurnRecord;
  previousDecision?: RefereeDecision | null;
  answeredQuestionBatches: UserQuestionBatch[];
}) {
  return [
    `Current milestone:\n${formatCurrentTask(args.taskPlan, args.currentTaskIndex)}`,
    `Milestone plan:\n${formatTaskPlan(args.taskPlan, args.currentTaskIndex)}`,
    `Full user request:\n${args.taskPrompt}`,
    `Current round: ${args.turnIndex + 1}`,
    "You are in the peer-critique phase.",
    "Critique the other participant's latest output for the current milestone only. Do not rewrite it and do not restate your own answer at length.",
    `Your latest output:\n${args.ownTurn.content}`,
    `Other participant's latest output:\n${args.opponentTurn.content}`,
    args.previousDecision
      ? `Referee guidance:\nSummary: ${args.previousDecision.summary}\nPreferred draft: ${args.previousDecision.preferredDraft}\nRequired next focus: ${args.previousDecision.requiredNextFocus}\nRemaining disagreements: ${args.previousDecision.remainingDisagreements}`
      : "There is no referee guidance yet.",
    `Answered user clarifications:\n${formatQuestionBatches(args.answeredQuestionBatches)}`,
    "Respond in Markdown with concrete strengths, weaknesses, omissions, and recommended fixes for the other participant's output on this milestone.",
  ].join("\n\n");
}

export function buildTaskPlanSystemPrompt() {
  return [
    "You are the referee's milestone planner for a structured multi-model debate.",
    "Your only job in this pass is to decompose the user's request into the smallest useful sequence of milestones.",
    "Return JSON only. Do not wrap the JSON in markdown fences.",
    "Create 1-5 sequential milestones.",
    "Use one milestone only when the prompt is truly atomic.",
    "Split milestones when the prompt clearly asks for multiple stages, rounds, passes, deliverables, or convergence checkpoints.",
    "Each milestone must have a short title, a concrete objective, and explicit completion criteria that a referee can judge independently.",
    "Do not judge convergence, do not pick a winner, do not draft the user-facing answer, and do not rewrite the user's request.",
  ].join("\n\n");
}

export function buildTaskPlanUserPrompt(taskPrompt: string) {
  return [
    `User request:\n${taskPrompt}`,
    [
      "Return a JSON object with:",
      "- tasks: array of 1-5 milestones",
      "- each milestone must include title, objective, completionCriteria",
    ].join("\n"),
  ].join("\n\n");
}

export function buildRefereeSystemPrompt(persona?: string) {
  return [
    "You are the referee and meta-evaluator in a structured multi-model debate.",
    "You are not a participant. Do not draft the answer, do not rewrite either draft, do not add new substantive arguments, and do not join the debate.",
    "You only evaluate the current milestone after both participant outputs and both participant critiques for the current cycle exist.",
    "Your job is to summarize the meaningful differences between the drafts, decide whether the current milestone has converged, identify the strongest draft so far, and request user clarification only when progress is blocked on missing information.",
    "Prefer brief judgments. Keep summary, requiredNextFocus, and remainingDisagreements concise and operational.",
    "Do not restate or paraphrase the drafts at length. Judge them; do not reproduce them.",
    "If another participant writing pass is needed for the current milestone, converged must be false.",
    "If the current milestone is complete, converged may be true even when later milestones still remain in the plan.",
    "Do not treat the whole run as complete unless the current milestone is the final milestone.",
    "On the final milestone, converged=true means one participant draft is ready to ship as the final artifact. In that case, preferredDraft must be participant_a or participant_b, not tie.",
    "Return JSON only. Do not wrap the JSON in markdown fences.",
    "If you request user input, produce 1-3 multiple-choice questions with 2-4 options each and exactly one recommended option per question.",
    persona ? `Persona override:\n${persona}` : "No persona override was supplied.",
  ].join("\n\n");
}

export function buildRefereeUserPrompt(args: {
  taskPrompt: string;
  taskPlan: DebateTask[];
  currentTaskIndex: number;
  turnIndex: number;
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
}) {
  return [
    `Current milestone under review:\n${formatCurrentTask(args.taskPlan, args.currentTaskIndex)}`,
    `Milestone plan:\n${formatTaskPlan(args.taskPlan, args.currentTaskIndex)}`,
    `Full user request:\n${args.taskPrompt}`,
    `Round under review: ${args.turnIndex + 1}`,
    "Meta-evaluation only: do not write a replacement draft for the user. Judge the two drafts that already exist.",
    "Convergence applies to the current milestone only. If the current milestone is done, set converged=true. If another pass is needed on the current milestone, set converged=false.",
    "This evaluation happens only after both participants have completed their draft for this cycle and both critiques have been provided.",
    `Participant A output:\n${args.participantATurn.content}`,
    `Participant B output:\n${args.participantBTurn.content}`,
    args.participantACritique
      ? `Participant A critique of B:\n${args.participantACritique.content}`
      : "Participant A has not critiqued B yet.",
    args.participantBCritique
      ? `Participant B critique of A:\n${args.participantBCritique.content}`
      : "Participant B has not critiqued A yet.",
    args.previousDecision
      ? `Previous referee decision:\nSummary: ${args.previousDecision.summary}\nRequired next focus: ${args.previousDecision.requiredNextFocus}`
      : "There is no previous referee decision.",
    `Answered user clarifications:\n${formatQuestionBatches(args.answeredQuestionBatches)}`,
    `Participant question proposals:\n${formatQuestionProposals(args.questionProposals)}`,
    [
      "Return a JSON object with these keys:",
      "- converged: boolean",
      "- confidence: number from 0 to 1",
      "- summary: string (1-2 short sentences)",
      "- preferredDraft: participant_a | participant_b | tie",
      "- requiredNextFocus: string (short operational guidance for the current milestone or the immediate next milestone, not a rewrite)",
      "- remainingDisagreements: string (short description of unresolved issues)",
      "- needsUserInput: boolean",
      "- questionBatch: optional object with questions[]",
    ].join("\n"),
  ].join("\n\n");
}
