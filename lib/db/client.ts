import "server-only";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import * as schema from "@/lib/db/schema";

const configuredDbPath = process.env.MULTI_AGENT_CONSULT_DB_PATH?.trim();
const dbFile = configuredDbPath
  ? path.isAbsolute(configuredDbPath)
    ? configuredDbPath
    : path.join(/* turbopackIgnore: true */ process.cwd(), configuredDbPath)
  : path.join(process.cwd(), "data", "multi-agent-consult.sqlite");
const dataDir = path.dirname(dbFile);

declare global {
  var __multiAgentSqlite: Database.Database | undefined;
  var __multiAgentDbInitialized: boolean | undefined;
}

function ensureColumn(
  database: Database.Database,
  tableName: string,
  columnName: string,
  definition: string,
) {
  const columns = database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function initializeDatabase(database: Database.Database) {
  if (global.__multiAgentDbInitialized) {
    return;
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      task_prompt TEXT NOT NULL,
      task_plan_json TEXT,
      status TEXT NOT NULL,
      stop_reason TEXT,
      max_turns INTEGER NOT NULL,
      current_turn INTEGER NOT NULL DEFAULT 0,
      current_task_index INTEGER NOT NULL DEFAULT 0,
      search_backend TEXT NOT NULL,
      workspace_mode TEXT NOT NULL,
      workspace_path TEXT,
      active_question_batch_id TEXT,
      final_solution TEXT,
      final_rationale TEXT,
      final_sources_json TEXT,
      error_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL,
      model_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      persona TEXT,
      label TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      phase TEXT NOT NULL,
      model_id TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      latency_ms INTEGER,
      usage_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_invocations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      role TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_records (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      turn_id TEXT,
      tool_invocation_id TEXT,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      domain TEXT NOT NULL,
      snippet TEXT,
      source_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS referee_decisions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      converged INTEGER NOT NULL,
      confidence REAL NOT NULL,
      summary TEXT NOT NULL,
      preferred_draft TEXT NOT NULL,
      required_next_focus TEXT NOT NULL,
      remaining_disagreements TEXT NOT NULL,
      needs_user_input INTEGER NOT NULL,
      question_batch_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_question_batches (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      questions_json TEXT NOT NULL,
      answers_json TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_turns_run_id_created_at
      ON turns (run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tool_invocations_run_id_created_at
      ON tool_invocations (run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_source_records_run_id_created_at
      ON source_records (run_id, created_at);
  `);

  ensureColumn(database, "runs", "task_plan_json", "TEXT");
  ensureColumn(database, "runs", "current_task_index", "INTEGER NOT NULL DEFAULT 0");

  global.__multiAgentDbInitialized = true;
}

function getSqlite() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!global.__multiAgentSqlite) {
    global.__multiAgentSqlite = new Database(dbFile);
    global.__multiAgentSqlite.pragma("journal_mode = WAL");
    initializeDatabase(global.__multiAgentSqlite);
  }

  return global.__multiAgentSqlite;
}

export const sqlite = getSqlite();
export const db = drizzle(sqlite, { schema });
