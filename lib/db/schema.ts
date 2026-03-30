import {
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  taskPrompt: text("task_prompt").notNull(),
  taskPlanJson: text("task_plan_json"),
  status: text("status").notNull(),
  stopReason: text("stop_reason"),
  maxTurns: integer("max_turns").notNull(),
  debateMode: text("debate_mode"),
  currentTurn: integer("current_turn").notNull().default(0),
  currentMilestoneTurn: integer("current_milestone_turn").notNull().default(0),
  currentTaskIndex: integer("current_task_index").notNull().default(0),
  searchBackend: text("search_backend").notNull(),
  workspaceMode: text("workspace_mode").notNull(),
  workspacePath: text("workspace_path"),
  activeQuestionBatchId: text("active_question_batch_id"),
  finalSolution: text("final_solution"),
  finalRationale: text("final_rationale"),
  finalSourcesJson: text("final_sources_json"),
  errorText: text("error_text"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
});

export const participants = sqliteTable("participants", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  role: text("role").notNull(),
  modelId: text("model_id").notNull(),
  provider: text("provider").notNull(),
  persona: text("persona"),
  label: text("label").notNull(),
});

export const turns = sqliteTable("turns", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  turnIndex: integer("turn_index").notNull(),
  role: text("role").notNull(),
  phase: text("phase").notNull(),
  modelId: text("model_id").notNull(),
  content: text("content").notNull(),
  summary: text("summary"),
  latencyMs: integer("latency_ms"),
  usageJson: text("usage_json"),
  createdAt: text("created_at").notNull(),
});

export const toolInvocations = sqliteTable("tool_invocations", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  turnId: text("turn_id").notNull(),
  role: text("role").notNull(),
  toolName: text("tool_name").notNull(),
  status: text("status").notNull(),
  inputJson: text("input_json").notNull(),
  outputJson: text("output_json"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
});

export const sourceRecords = sqliteTable("source_records", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  turnId: text("turn_id"),
  toolInvocationId: text("tool_invocation_id"),
  url: text("url").notNull(),
  title: text("title").notNull(),
  domain: text("domain").notNull(),
  snippet: text("snippet"),
  sourceType: text("source_type").notNull(),
  createdAt: text("created_at").notNull(),
});

export const refereeDecisions = sqliteTable("referee_decisions", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  turnIndex: integer("turn_index").notNull(),
  converged: integer("converged", { mode: "boolean" }).notNull(),
  confidence: real("confidence").notNull(),
  summary: text("summary").notNull(),
  preferredDraft: text("preferred_draft").notNull(),
  requiredNextFocus: text("required_next_focus").notNull(),
  remainingDisagreements: text("remaining_disagreements").notNull(),
  blockingIssuesJson: text("blocking_issues_json"),
  carryForwardNotesJson: text("carry_forward_notes_json"),
  diminishingReturnsJson: text("diminishing_returns_json"),
  needsUserInput: integer("needs_user_input", { mode: "boolean" }).notNull(),
  questionBatchId: text("question_batch_id"),
  createdAt: text("created_at").notNull(),
});

export const userQuestionBatches = sqliteTable("user_question_batches", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  status: text("status").notNull(),
  questionsJson: text("questions_json").notNull(),
  answersJson: text("answers_json"),
  createdAt: text("created_at").notNull(),
  answeredAt: text("answered_at"),
});
