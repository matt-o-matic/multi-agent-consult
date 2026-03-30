import {
  getDebateModeLabel,
  getDebateRoleLabel,
  isWritersRoomMode,
} from "@/lib/debate-mode";
import type {
  DebateMode,
  DebateTask,
  EvidencePacket,
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
  debateMode: DebateMode,
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

      return `${getDebateRoleLabel(debateMode, entry.role)}:\n${proposals}`;
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

function formatStringList(items: string[] | undefined, emptyMessage: string) {
  if (!items || items.length === 0) {
    return emptyMessage;
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function formatEvidencePacket(packet?: EvidencePacket | null) {
  if (!packet || (packet.items.length === 0 && packet.extractedNotes.length === 0)) {
    return "No structured shared evidence is available yet for this milestone.";
  }

  const notes = packet.extractedNotes.length
    ? packet.extractedNotes.map((note) => `- ${note}`).join("\n")
    : "- No extracted notes.";
  const items = packet.items.length
    ? packet.items
        .map((item) =>
          [
            `- ${item.title} (${item.domain})`,
            `  URL: ${item.url}`,
            item.snippet ? `  Snippet: ${item.snippet}` : null,
            item.toolName ? `  Tool: ${item.toolName}` : null,
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        )
        .join("\n")
    : "- No cited sources were captured.";

  return [
    `Gathered by: ${packet.gatheredBy}`,
    `Cycle turn index: ${packet.turnIndex}`,
    `Phase: ${packet.phase}`,
    `Tools used: ${packet.toolNames.length ? packet.toolNames.join(", ") : "none recorded"}`,
    "Extracted notes:",
    notes,
    "Evidence items:",
    items,
  ].join("\n");
}

function formatEvidencePackets(packets: EvidencePacket[]) {
  if (packets.length === 0) {
    return "No structured evidence packets are available yet for this milestone.";
  }

  return packets
    .map((packet, index) => `Evidence packet ${index + 1}:\n${formatEvidencePacket(packet)}`)
    .join("\n\n");
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

function formatTurnContent(turn: TurnRecord | null | undefined, emptyMessage: string) {
  return turn ? turn.content : emptyMessage;
}

function formatModeGuidance(debateMode: DebateMode) {
  if (isWritersRoomMode(debateMode)) {
    return [
      "Mode: Writer's room.",
      "Participant A is the Writer and is the only participant who authors draft output.",
      "Participant B is the Editor and critiques the Writer's draft instead of authoring a competing draft.",
    ].join("\n");
  }

  return [
    "Mode: Collaborative debate.",
    "Participant A and Participant B both author draft output, critique each other, and revise until the referee says the milestone is ready.",
  ].join("\n");
}

export function buildParticipantSystemPrompt(args: {
  debateMode: DebateMode;
  role: ParticipantRole;
  persona?: string;
  manifest?: WorkspaceManifest | null;
}) {
  const roleName = getDebateRoleLabel(args.debateMode, args.role);
  const writersRoom = isWritersRoomMode(args.debateMode);
  const roleDirective =
    writersRoom && args.role === "participant_a"
      ? "You are the Writer. Your job is to write the current milestone, revise from critique, and avoid pretending missing requirements were specified."
      : writersRoom && args.role === "participant_b"
        ? "You are the Editor. Your job is to critique the Writer's draft, call out missing information, and avoid authoring a competing replacement draft."
        : "You are one of two equal participants in a structured collaboration. Produce strong work, engage directly with the other participant's ideas, and revise when the referee keeps the milestone open.";

  return [
    `You are ${roleName} in a structured multi-model collaboration.`,
    roleDirective,
    "Ask clarifying questions instead of guessing when missing information would materially change the answer.",
    "If you need clarification from the user, do not ask directly. Use the propose_user_questions tool instead.",
    "Stay tightly scoped to the current milestone. Do not spend tokens solving later milestones early.",
    "Use tools when they materially improve the answer. Prefer evidence over unsupported claims.",
    "Only do external research when the current milestone actually needs it.",
    "Do not put raw URLs inline in the solution body.",
    args.persona ? `Persona override:\n${args.persona}` : "No persona override was supplied.",
    formatWorkspaceManifest(args.manifest),
  ].join("\n\n");
}

export function buildParticipantUserPrompt(args: {
  debateMode: DebateMode;
  role: ParticipantRole;
  taskPrompt: string;
  taskPlan: DebateTask[];
  currentTaskIndex: number;
  currentMilestoneTurn: number;
  maxMilestoneTurns: number;
  turnIndex: number;
  phase: "proposal" | "revision";
  previousOwnTurn?: TurnRecord | null;
  previousOpponentTurn?: TurnRecord | null;
  previousOwnCritique?: TurnRecord | null;
  previousOpponentCritique?: TurnRecord | null;
  previousDecision?: RefereeDecision | null;
  carryForwardNotes?: string[];
  sharedEvidence?: EvidencePacket | null;
  answeredQuestionBatches: UserQuestionBatch[];
}) {
  const roleName = getDebateRoleLabel(args.debateMode, args.role);
  const writersRoom = isWritersRoomMode(args.debateMode);
  const phaseInstruction =
    writersRoom && args.role === "participant_a"
      ? args.phase === "proposal"
        ? "Write the current milestone only. Do not skip ahead to later milestones."
        : "Revise the current milestone only. Use the editor's critique, the referee guidance, and any answered clarifications."
      : args.phase === "proposal"
        ? "Produce an independent initial proposal focused on the current milestone only."
        : "Produce a revised proposal focused on the current milestone only. Use the referee guidance, the other participant's latest output, and the critique exchange from the last cycle.";

  const modeSpecificInstruction =
    writersRoom && args.role === "participant_b"
      ? "This mode normally does not ask the Editor to produce a standalone draft. If you were called here, keep any response brief, question-first, and explicitly note missing information."
      : "Stay on the current milestone. Do not skip ahead to later milestones unless the current milestone explicitly requires it. Defer research unless this milestone actually needs external grounding.";

  return [
    formatModeGuidance(args.debateMode),
    `Current milestone:\n${formatCurrentTask(args.taskPlan, args.currentTaskIndex)}`,
    `Milestone plan:\n${formatTaskPlan(args.taskPlan, args.currentTaskIndex)}`,
    `Full user request:\n${args.taskPrompt}`,
    `Global cycle: ${args.turnIndex + 1}`,
    `Current milestone cycle: ${args.currentMilestoneTurn + 1} of ${args.maxMilestoneTurns}`,
    `${roleName} instructions: ${phaseInstruction}`,
    `Your previous output:\n${formatTurnContent(args.previousOwnTurn, "You do not have a previous output yet for this workflow.")}`,
    `Other participant's latest output:\n${formatTurnContent(args.previousOpponentTurn, "The other participant does not have a previous output yet.")}`,
    `Your last critique:\n${formatTurnContent(args.previousOwnCritique, "You have not produced a critique yet.")}`,
    `Latest critique of your output:\n${formatTurnContent(args.previousOpponentCritique, "You have not received direct critique yet.")}`,
    args.previousDecision
      ? `Referee guidance:\nSummary: ${args.previousDecision.summary}\nPreferred draft: ${args.previousDecision.preferredDraft}\nRequired next focus: ${args.previousDecision.requiredNextFocus}\nRemaining disagreements: ${args.previousDecision.remainingDisagreements}\nBlocking now:\n${formatStringList(args.previousDecision.blockingIssues, "- None recorded.")}\nCarry forward:\n${formatStringList(args.previousDecision.carryForwardNotes, "- None recorded.")}\nDiminishing returns:\n${formatStringList(args.previousDecision.diminishingReturns, "- None recorded.")}`
      : "There is no referee guidance yet.",
    `Carry-forward notes from earlier milestone decisions:\n${formatStringList(args.carryForwardNotes, "- None recorded.")}`,
    `Shared evidence from the other participant on this milestone:\n${formatEvidencePacket(args.sharedEvidence)}`,
    `Answered user clarifications:\n${formatQuestionBatches(args.answeredQuestionBatches)}`,
    "If something essential is missing, surface clarifying questions instead of making up specifics.",
    modeSpecificInstruction,
    "Respond in Markdown. Make the answer directly usable for the current milestone. Keep citations out of the body; the app will attach structured sources separately.",
  ].join("\n\n");
}

export function buildParticipantCritiqueUserPrompt(args: {
  debateMode: DebateMode;
  role: ParticipantRole;
  taskPrompt: string;
  taskPlan: DebateTask[];
  currentTaskIndex: number;
  currentMilestoneTurn: number;
  maxMilestoneTurns: number;
  turnIndex: number;
  ownTurn?: TurnRecord | null;
  opponentTurn: TurnRecord;
  previousDecision?: RefereeDecision | null;
  carryForwardNotes?: string[];
  sharedEvidence?: EvidencePacket | null;
  answeredQuestionBatches: UserQuestionBatch[];
}) {
  const roleName = getDebateRoleLabel(args.debateMode, args.role);
  const writersRoom = isWritersRoomMode(args.debateMode);
  const critiqueInstruction =
    writersRoom
      ? "You are in the editorial critique phase. Critique the Writer's latest output for the current milestone only. Do not author a replacement draft. Distinguish blocking-now issues, carry-forward issues for later milestones, and non-blocking polish that should not keep this milestone open."
      : "You are in the peer-critique phase. Critique the other participant's latest output for the current milestone only. Do not rewrite it and do not restate your own answer at length.";

  return [
    formatModeGuidance(args.debateMode),
    `Current milestone:\n${formatCurrentTask(args.taskPlan, args.currentTaskIndex)}`,
    `Milestone plan:\n${formatTaskPlan(args.taskPlan, args.currentTaskIndex)}`,
    `Full user request:\n${args.taskPrompt}`,
    `Global cycle: ${args.turnIndex + 1}`,
    `Current milestone cycle: ${args.currentMilestoneTurn + 1} of ${args.maxMilestoneTurns}`,
    `${roleName} instructions: ${critiqueInstruction}`,
    `Your latest authored output:\n${formatTurnContent(args.ownTurn, "You have not authored a draft in this mode.")}`,
    `Other participant's latest output:\n${args.opponentTurn.content}`,
    args.previousDecision
      ? `Referee guidance:\nSummary: ${args.previousDecision.summary}\nPreferred draft: ${args.previousDecision.preferredDraft}\nRequired next focus: ${args.previousDecision.requiredNextFocus}\nRemaining disagreements: ${args.previousDecision.remainingDisagreements}\nBlocking now:\n${formatStringList(args.previousDecision.blockingIssues, "- None recorded.")}\nCarry forward:\n${formatStringList(args.previousDecision.carryForwardNotes, "- None recorded.")}\nDiminishing returns:\n${formatStringList(args.previousDecision.diminishingReturns, "- None recorded.")}`
      : "There is no referee guidance yet.",
    `Carry-forward notes from earlier milestone decisions:\n${formatStringList(args.carryForwardNotes, "- None recorded.")}`,
    `Structured evidence available for this critique:\n${formatEvidencePacket(args.sharedEvidence)}`,
    `Answered user clarifications:\n${formatQuestionBatches(args.answeredQuestionBatches)}`,
    "If missing information blocks a fair critique, propose clarifying questions instead of assuming.",
    writersRoom
      ? "Respond in Markdown. Use headings or bullets for: blocking now, carry forward, and polish-only observations."
      : "Respond in Markdown with concrete strengths, weaknesses, omissions, and recommended fixes for the current milestone.",
  ].join("\n\n");
}

export function buildTaskPlanSystemPrompt(debateMode: DebateMode) {
  const modeInstruction = isWritersRoomMode(debateMode)
    ? "Plan milestones for a writer's room workflow where the Writer drafts, the Editor critiques, and the referee decides when the Writer can move on."
    : "Plan milestones for a collaborative debate workflow where both participants draft, critique each other, and revise until the referee says the milestone is ready.";

  return [
    "You are the referee's milestone planner for a structured multi-model run.",
    modeInstruction,
    "Your only job in this pass is to either decompose the user's request into the smallest useful sequence of milestones or ask clarifying questions before planning if the brief is materially underspecified.",
    "Ask questions instead of inventing milestones when missing information would change the plan, the order of work, or the acceptance criteria.",
    "Honor explicit user-stated stages first. If the prompt names stages like critique, rewrite, converge, research, or finalize, those should normally become the milestone backbone unless a split is truly unavoidable.",
    "Prefer productive work units over micro-audits. Low-leverage cleanup belongs inside a broader milestone instead of becoming its own gating milestone.",
    "If you need clarification, ask as many concise multiple-choice questions as materially necessary instead of compressing them into an artificial limit.",
    "For question options, prefer structured objects with id, label, description, and optional recommended, but plain string options are also acceptable.",
    "Return JSON only. Do not wrap the JSON in markdown fences.",
    "Return exactly one of these two shapes:",
    '- {"outcome":"tasks","tasks":[{"title":"","objective":"","completionCriteria":""}]}',
    '- {"outcome":"question_batch","summary":"","questionBatch":{"questions":[...]}}',
    "Create 1-5 sequential milestones when outcome is tasks.",
    "Use one milestone only when the prompt is truly atomic.",
    "Split milestones when the prompt clearly asks for multiple stages, rounds, passes, deliverables, or convergence checkpoints.",
    "Each milestone must have a short title, a concrete objective, and explicit completion criteria that a referee can judge independently.",
    "If outcome is question_batch, do not return tasks in the same object.",
    "Do not judge convergence, do not pick a winner, do not draft the user-facing answer, and do not rewrite the user's request.",
  ].join("\n\n");
}

export function buildTaskPlanUserPrompt(args: {
  debateMode: DebateMode;
  taskPrompt: string;
  answeredQuestionBatches: UserQuestionBatch[];
}) {
  return [
    `Mode:\n${getDebateModeLabel(args.debateMode)}`,
    `Mode guidance:\n${formatModeGuidance(args.debateMode)}`,
    `User request:\n${args.taskPrompt}`,
    `Answered user clarifications:\n${formatQuestionBatches(args.answeredQuestionBatches)}`,
    [
      "Return either:",
      '- {"outcome":"tasks","tasks":[{"title":"","objective":"","completionCriteria":""}]}',
      "or",
      '- {"outcome":"question_batch","summary":"","questionBatch":{"questions":[{"question":"","options":[...]}]}}',
    ].join("\n"),
    "If the user already described stages or rounds, preserve that structure unless doing so would make the milestones incoherent.",
    "If you return a question batch, ask as many questions as needed. Prefer concise option lists and use plain strings only if you do not need richer option metadata.",
  ].join("\n\n");
}

export function buildRefereeSystemPrompt(args: {
  debateMode: DebateMode;
  persona?: string;
}) {
  const writersRoom = isWritersRoomMode(args.debateMode);
  const cycleInstruction = writersRoom
    ? "You only evaluate the current milestone after the Writer has produced the current draft and the Editor has produced the current critique for that same cycle."
    : "You only evaluate the current milestone after both participant outputs and both participant critiques for the current cycle exist.";
  const preferenceInstruction = writersRoom
    ? "In writer's room mode, participant_b is the Editor and does not author the final draft. preferredDraft must never be participant_b."
    : "On the final milestone, converged=true means one participant draft is ready to ship as the final artifact. In that case, preferredDraft must be participant_a or participant_b, not tie.";

  return [
    "You are the referee and meta-evaluator in a structured multi-model run.",
    "You are not a participant. Do not draft the answer, do not rewrite either draft, do not add new substantive arguments, and do not join the debate.",
    cycleInstruction,
    "Your job is to judge the current milestone only, summarize the meaningful differences, decide whether the milestone has converged, identify the strongest participant-authored draft so far, and request user clarification when ambiguity blocks fair judgment.",
    "Use a good-enough-to-advance standard, not a perfection standard.",
    "Classify issues as blocking now, carry forward to a later milestone, or diminishing-return polish.",
    "Future-milestone concerns must not block the current milestone unless they directly prevent acceptance of this milestone.",
    "Compare against the previous cycle's decision. If the same concern was already addressed or is now only polish, cut off the loop and advance with carry-forward notes.",
    "Ask clarifying questions instead of guessing when missing information materially affects milestone acceptance.",
    "Prefer brief judgments. Keep summary, requiredNextFocus, and remainingDisagreements concise and operational.",
    "Do not restate or paraphrase the drafts at length. Judge them; do not reproduce them.",
    "If another participant writing pass is needed for the current milestone, converged must be false.",
    "If the current milestone is complete, converged may be true even when later milestones still remain in the plan.",
    "Do not treat the whole run as complete unless the current milestone is the final milestone.",
    preferenceInstruction,
    "Return JSON only. Do not wrap the JSON in markdown fences.",
    "If you request user input, ask as many concise multiple-choice questions as materially necessary.",
    "Prefer 2-4 options per question, but do not drop important clarifications just to stay under an arbitrary count.",
    "Prefer structured option objects with id, label, description, and optional recommended, but plain string options are acceptable when that is faster or clearer.",
    args.persona ? `Persona override:\n${args.persona}` : "No persona override was supplied.",
  ].join("\n\n");
}

export function buildRefereeUserPrompt(args: {
  debateMode: DebateMode;
  taskPrompt: string;
  taskPlan: DebateTask[];
  currentTaskIndex: number;
  currentMilestoneTurn: number;
  maxMilestoneTurns: number;
  turnIndex: number;
  participantATurn?: TurnRecord | null;
  participantBTurn?: TurnRecord | null;
  participantACritique?: TurnRecord | null;
  participantBCritique?: TurnRecord | null;
  previousDecision?: RefereeDecision | null;
  carryForwardNotes?: string[];
  evidencePackets: EvidencePacket[];
  answeredQuestionBatches: UserQuestionBatch[];
  questionProposals: Array<{
    role: ParticipantRole;
    proposals: UserQuestionProposal[];
  }>;
}) {
  const writersRoom = isWritersRoomMode(args.debateMode);
  const cycleInstruction = writersRoom
    ? "Meta-evaluation only: judge the Writer's draft and the Editor's critique. If the critique identifies substantive unresolved issues, converged must be false and the Writer should revise again."
    : "Meta-evaluation only: do not write a replacement draft for the user. Judge the two drafts that already exist plus the critique exchange.";
  const preferenceInstruction = writersRoom
    ? "In this mode, participant_a is the Writer and participant_b is the Editor. preferredDraft may be participant_a or tie, but never participant_b."
    : "Convergence applies to the current milestone only. If the current milestone is done, set converged=true. If another pass is needed on the current milestone, set converged=false.";

  return [
    `Mode:\n${getDebateModeLabel(args.debateMode)}`,
    `Mode guidance:\n${formatModeGuidance(args.debateMode)}`,
    `Current milestone under review:\n${formatCurrentTask(args.taskPlan, args.currentTaskIndex)}`,
    `Milestone plan:\n${formatTaskPlan(args.taskPlan, args.currentTaskIndex)}`,
    `Full user request:\n${args.taskPrompt}`,
    `Global cycle under review: ${args.turnIndex + 1}`,
    `Current milestone cycle: ${args.currentMilestoneTurn + 1} of ${args.maxMilestoneTurns}`,
    cycleInstruction,
    preferenceInstruction,
    `Participant A output:\n${formatTurnContent(args.participantATurn, "Participant A has not produced a draft for this cycle.")}`,
    writersRoom
      ? `Participant B editorial context:\n${formatTurnContent(args.participantBTurn, "Participant B does not author a draft in this mode.")}`
      : `Participant B output:\n${formatTurnContent(args.participantBTurn, "Participant B has not produced a draft for this cycle.")}`,
    writersRoom
      ? `Editor critique of the Writer:\n${formatTurnContent(args.participantBCritique, "The editor has not critiqued the writer yet.")}`
      : `Participant A critique of B:\n${formatTurnContent(args.participantACritique, "Participant A has not critiqued B yet.")}`,
    writersRoom
      ? `Writer critique slot:\n${formatTurnContent(args.participantACritique, "The Writer does not produce critique turns in this mode.")}`
      : `Participant B critique of A:\n${formatTurnContent(args.participantBCritique, "Participant B has not critiqued A yet.")}`,
    args.previousDecision
      ? `Previous referee decision:\nSummary: ${args.previousDecision.summary}\nRequired next focus: ${args.previousDecision.requiredNextFocus}\nBlocking now:\n${formatStringList(args.previousDecision.blockingIssues, "- None recorded.")}\nCarry forward:\n${formatStringList(args.previousDecision.carryForwardNotes, "- None recorded.")}\nDiminishing returns:\n${formatStringList(args.previousDecision.diminishingReturns, "- None recorded.")}`
      : "There is no previous referee decision.",
    `Carry-forward notes from earlier milestone decisions:\n${formatStringList(args.carryForwardNotes, "- None recorded.")}`,
    `Structured evidence gathered on this milestone:\n${formatEvidencePackets(args.evidencePackets)}`,
    `Answered user clarifications:\n${formatQuestionBatches(args.answeredQuestionBatches)}`,
    `Participant question proposals:\n${formatQuestionProposals(args.questionProposals, args.debateMode)}`,
    [
      "Return a JSON object with these keys:",
      "- converged: boolean",
      "- confidence: number from 0 to 1",
      "- summary: string (1-2 short sentences)",
      "- preferredDraft: participant_a | participant_b | tie",
      "- requiredNextFocus: string (short operational guidance for the current milestone or the immediate next milestone, not a rewrite)",
      "- remainingDisagreements: string (short description of unresolved issues)",
      "- blockingIssues: string[]",
      "- carryForwardNotes: string[]",
      "- diminishingReturns: string[]",
      "- needsUserInput: boolean",
      "- questionBatch: optional object with questions[]",
    ].join("\n"),
    "You must review participant question proposals explicitly. If they reveal a real ambiguity, convert them into a questionBatch. If not, keep needsUserInput false.",
  ].join("\n\n");
}
