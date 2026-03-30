export type ProviderKey = "openrouter";
export type SearchBackend = "off" | "provider_native" | "brave";
export type WorkspaceMode = "off" | "path";
export type DebateMode = "collaborative_debate" | "writers_room";
export type ParticipantRole = "participant_a" | "participant_b";
export type ActorRole = ParticipantRole | "referee";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_user"
  | "completed"
  | "failed"
  | "cancelled";
export type StopReason =
  | "converged"
  | "max_turns"
  | "user_cancelled"
  | "failed";
export type TurnPhase =
  | "planning"
  | "proposal"
  | "critique"
  | "revision"
  | "referee"
  | "final";
export type ToolInvocationStatus = "started" | "success" | "error";
export type QuestionBatchStatus = "pending" | "answered" | "skipped";

export interface PricingInfo {
  prompt?: string;
  completion?: string;
  webSearch?: string;
}

export interface NormalizedModel {
  id: string;
  name: string;
  provider: ProviderKey;
  description?: string;
  contextLength?: number;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  supportsProviderNativeSearch: boolean;
  pricing?: PricingInfo;
}

export interface ParticipantConfig {
  role: ActorRole;
  modelId: string;
  provider: ProviderKey;
  persona?: string;
  label: string;
}

export interface RunConfig {
  taskPrompt: string;
  maxTurns: number;
  debateMode?: DebateMode;
  searchBackend: SearchBackend;
  workspaceMode: WorkspaceMode;
  workspacePath?: string | null;
  participantA: ParticipantConfig;
  participantB: ParticipantConfig;
  referee: ParticipantConfig;
}

export interface WorkspaceCommand {
  id: string;
  label: string;
  command: string[];
}

export interface WorkspaceManifest {
  rootPath: string;
  commands: WorkspaceCommand[];
}

export interface SourceRecord {
  id: string;
  url: string;
  title: string;
  domain: string;
  snippet?: string;
  sourceType: "web" | "workspace" | "generated";
  toolInvocationId?: string;
  turnId?: string;
  createdAt: string;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface TurnRecord {
  id: string;
  runId: string;
  turnIndex: number;
  role: ActorRole;
  phase: TurnPhase;
  modelId: string;
  content: string;
  summary?: string | null;
  latencyMs?: number | null;
  tokenUsage?: TokenUsage | null;
  createdAt: string;
}

export interface ToolInvocationRecord {
  id: string;
  runId: string;
  turnId: string;
  role: ParticipantRole;
  toolName: string;
  status: ToolInvocationStatus;
  inputJson: string;
  outputJson?: string | null;
  errorMessage?: string | null;
  createdAt: string;
}

export interface QuestionOption {
  id: string;
  label: string;
  description: string;
  recommended?: boolean;
}

export interface UserQuestionProposal {
  id: string;
  question: string;
  rationale?: string;
  options: QuestionOption[];
  notePlaceholder?: string;
}

export interface UserQuestion {
  id: string;
  question: string;
  options: QuestionOption[];
  notePlaceholder?: string;
}

export interface UserQuestionAnswer {
  questionId: string;
  selectedOptionId?: string | null;
  note?: string | null;
}

export interface DebateTask {
  id: string;
  title: string;
  objective: string;
  completionCriteria: string;
}

export interface EvidencePacketItem {
  title: string;
  domain: string;
  url: string;
  snippet?: string;
  toolName?: string;
}

export interface EvidencePacket {
  gatheredBy: ParticipantRole;
  turnId: string;
  turnIndex: number;
  phase: TurnPhase;
  toolNames: string[];
  extractedNotes: string[];
  items: EvidencePacketItem[];
}

export interface UserQuestionBatch {
  id: string;
  runId: string;
  status: QuestionBatchStatus;
  questions: UserQuestion[];
  answers?: UserQuestionAnswer[] | null;
  createdAt: string;
  answeredAt?: string | null;
}

export interface RefereeDecision {
  id: string;
  runId: string;
  turnIndex: number;
  converged: boolean;
  confidence: number;
  summary: string;
  preferredDraft: ParticipantRole | "tie";
  requiredNextFocus: string;
  remainingDisagreements: string;
  blockingIssues?: string[];
  carryForwardNotes?: string[];
  diminishingReturns?: string[];
  needsUserInput: boolean;
  questionBatch?: UserQuestionBatch | null;
  createdAt: string;
}

export interface FinalConsensus {
  solution: string;
  rationale: string;
  sources: SourceRecord[];
}

export interface LiveTurnState {
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

export interface RunLiveState {
  activeTurns: LiveTurnState[];
  latestStatusMessage?: string | null;
  updatedAt?: string | null;
}

export interface RunSummary {
  id: string;
  taskPrompt: string;
  status: RunStatus;
  stopReason?: StopReason | null;
  debateMode: DebateMode;
  createdAt: string;
  updatedAt: string;
  participantA: ParticipantConfig;
  participantB: ParticipantConfig;
  referee: ParticipantConfig;
}

export interface RunDetail extends RunSummary {
  maxTurns: number;
  searchBackend: SearchBackend;
  workspacePath?: string | null;
  currentTurn: number;
  currentMilestoneTurn: number;
  currentTaskIndex: number;
  taskPlan: DebateTask[];
  liveState?: RunLiveState | null;
  errorText?: string | null;
  activeQuestionBatchId?: string | null;
  finalConsensus?: FinalConsensus | null;
  turns: TurnRecord[];
  toolInvocations: ToolInvocationRecord[];
  sources: SourceRecord[];
  refereeDecisions: RefereeDecision[];
  questionBatches: UserQuestionBatch[];
}

export type RunEvent =
  | {
      type: "status";
      runId: string;
      status: RunStatus;
      stopReason?: StopReason | null;
      message?: string;
      at: string;
    }
  | {
      type: "turn_started";
      runId: string;
      attempt: number;
      maxAttempts: number;
      role: ActorRole;
      phase: TurnPhase;
      turnIndex: number;
      modelId: string;
      at: string;
    }
  | {
      type: "turn_delta";
      runId: string;
      attempt: number;
      maxAttempts: number;
      role: ActorRole;
      phase: TurnPhase;
      turnIndex: number;
      modelId: string;
      delta: string;
      content: string;
      at: string;
    }
  | {
      type: "turn_retrying";
      runId: string;
      attempt: number;
      lastError: string;
      maxAttempts: number;
      modelId: string;
      phase: TurnPhase;
      retryDelayMs: number;
      role: ActorRole;
      turnIndex: number;
      at: string;
    }
  | {
      type: "turn_completed";
      runId: string;
      turn: TurnRecord;
      at: string;
    }
  | {
      type: "tool_event";
      runId: string;
      tool: ToolInvocationRecord;
      sources?: SourceRecord[];
      at: string;
    }
  | {
      type: "referee_decision";
      runId: string;
      decision: RefereeDecision;
      at: string;
    }
  | {
      type: "question_batch";
      runId: string;
      batch: UserQuestionBatch;
      at: string;
    }
  | {
      type: "question_batch_answered";
      runId: string;
      batch: UserQuestionBatch;
      at: string;
    }
  | {
      type: "completed";
      runId: string;
      finalConsensus: FinalConsensus | null;
      stopReason: StopReason;
      at: string;
    };
