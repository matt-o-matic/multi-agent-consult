import { z } from "zod";

import type { ParticipantConfig } from "@/lib/types";

const participantSchema = z.object({
  role: z.enum(["participant_a", "participant_b", "referee"]),
  modelId: z.string().min(1),
  provider: z.literal("openrouter"),
  persona: z.string().trim().max(4000).optional().or(z.literal("")),
  label: z.string().min(1).max(120),
});

export const runConfigSchema = z.object({
  taskPrompt: z.string().trim().min(1).max(12000),
  maxTurns: z.number().int().min(1).max(6),
  debateMode: z.enum(["collaborative_debate", "writers_room"]).optional(),
  searchBackend: z.enum(["off", "provider_native", "brave"]),
  workspaceMode: z.enum(["off", "path"]),
  workspacePath: z.string().trim().max(1000).nullish(),
  participantA: participantSchema.refine(
    (value) => value.role === "participant_a",
    "participantA role must be participant_a",
  ),
  participantB: participantSchema.refine(
    (value) => value.role === "participant_b",
    "participantB role must be participant_b",
  ),
  referee: participantSchema.refine(
    (value) => value.role === "referee",
    "referee role must be referee",
  ),
});

export const workspaceValidationSchema = z.object({
  workspacePath: z.string().trim().min(1),
});

const answerSchema = z.object({
  questionId: z.string().min(1),
  selectedOptionId: z.string().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

export const questionBatchAnswerSchema = z.object({
  answers: z.array(answerSchema).min(1),
});

export type RunConfigInput = z.infer<typeof runConfigSchema>;
export type WorkspaceValidationInput = z.infer<typeof workspaceValidationSchema>;
export type QuestionBatchAnswerInput = z.infer<typeof questionBatchAnswerSchema>;

export function normalizeParticipantConfig(
  participant: ParticipantConfig,
): ParticipantConfig {
  return {
    ...participant,
    persona: participant.persona?.trim() || undefined,
  };
}
