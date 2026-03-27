import { sqlite } from "@/lib/db/client";

export function clearDatabase() {
  sqlite.exec(`
    DELETE FROM source_records;
    DELETE FROM tool_invocations;
    DELETE FROM referee_decisions;
    DELETE FROM user_question_batches;
    DELETE FROM turns;
    DELETE FROM participants;
    DELETE FROM runs;
  `);
}
