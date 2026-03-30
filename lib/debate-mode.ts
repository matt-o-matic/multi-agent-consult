import type { ActorRole, DebateMode, ParticipantRole } from "@/lib/types";

export const DEFAULT_DEBATE_MODE: DebateMode = "collaborative_debate";

export const DEBATE_MODE_OPTIONS: Array<{
  value: DebateMode;
  label: string;
  description: string;
}> = [
  {
    value: "collaborative_debate",
    label: "Collaborative debate",
    description:
      "Two peers draft, critique, and revise together while the referee plans milestones and judges convergence.",
  },
  {
    value: "writers_room",
    label: "Writer's room",
    description:
      "A writer produces the draft, an editor critiques it, and the referee decides when each milestone is ready to move on.",
  },
];

const MODE_METADATA = {
  collaborative_debate: {
    label: "Collaborative debate",
    roleLabels: {
      participant_a: "Participant A",
      participant_b: "Participant B",
      referee: "Referee",
    },
    roleDescriptions: {
      participant_a:
        "This model produces an independent answer, critiques the other participant, and revises when the referee keeps the milestone open.",
      participant_b:
        "This model is the counterweight. It should bring a genuinely different perspective, critique the other participant, and revise when needed.",
      referee:
        "The referee decomposes the request into milestones, watches the critique loop, and decides when each milestone has converged.",
    },
    roleTitles: {
      participant_a: "Independent draft and critique",
      participant_b: "Independent counterweight",
      referee: "Task planner and convergence judge",
    },
    instructionPlaceholders: {
      participant_a:
        "Optional role guidance for participant A. Tone, background, risk tolerance, or what to optimize for.",
      participant_b:
        "Optional role guidance for participant B. This is useful for a different lens, writing taste, or decision style.",
      referee:
        "Optional role guidance for the referee. Keep it evaluative, selective, and meta instead of participatory.",
    },
    outputLabels: {
      participant_a: {
        primary: "Proposal or revision",
        secondary: "Critiques",
      },
      participant_b: {
        primary: "Proposal or revision",
        secondary: "Critiques",
      },
      referee: {
        primary: "Planning passes",
        secondary: "Evaluations",
      },
    },
  },
  writers_room: {
    label: "Writer's room",
    roleLabels: {
      participant_a: "Writer",
      participant_b: "Editor",
      referee: "Referee",
    },
    roleDescriptions: {
      participant_a:
        "This model writes the draft, absorbs editorial critique, and revises until the referee says the milestone is ready to move on.",
      participant_b:
        "This model is the editor. It should critique the writer's draft, surface gaps and questions, and avoid authoring a competing rewrite.",
      referee:
        "The referee plans milestones, decides whether the editor's critique is substantive, and judges when the writer's current milestone is ready.",
    },
    roleTitles: {
      participant_a: "Primary draft author",
      participant_b: "Critical editorial pass",
      referee: "Task planner and room lead",
    },
    instructionPlaceholders: {
      participant_a:
        "Optional guidance for the writer. Voice, audience, structure, sharpness, or what the writing should optimize for.",
      participant_b:
        "Optional guidance for the editor. What to push on, what quality bar to enforce, and what assumptions to challenge.",
      referee:
        "Optional role guidance for the referee. Keep it milestone-focused, selective, and explicit about when to ask clarifying questions.",
    },
    outputLabels: {
      participant_a: {
        primary: "Drafts or revisions",
        secondary: "Critiques",
      },
      participant_b: {
        primary: "Drafts or revisions",
        secondary: "Editorial critiques",
      },
      referee: {
        primary: "Planning passes",
        secondary: "Evaluations",
      },
    },
  },
} satisfies Record<
  DebateMode,
  {
    label: string;
    roleLabels: Record<ActorRole, string>;
    roleDescriptions: Record<ActorRole, string>;
    roleTitles: Record<ActorRole, string>;
    instructionPlaceholders: Record<ActorRole, string>;
    outputLabels: Record<
      ActorRole,
      {
        primary: string;
        secondary: string;
      }
    >;
  }
>;

export function normalizeDebateMode(mode?: DebateMode | null): DebateMode {
  return mode ?? DEFAULT_DEBATE_MODE;
}

export function getDebateModeLabel(mode?: DebateMode | null) {
  return MODE_METADATA[normalizeDebateMode(mode)].label;
}

export function getDebateRoleLabel(
  mode: DebateMode | null | undefined,
  role: ActorRole,
) {
  return MODE_METADATA[normalizeDebateMode(mode)].roleLabels[role];
}

export function getDebateRoleTitle(
  mode: DebateMode | null | undefined,
  role: ActorRole,
) {
  return MODE_METADATA[normalizeDebateMode(mode)].roleTitles[role];
}

export function getDebateRoleDescription(
  mode: DebateMode | null | undefined,
  role: ActorRole,
) {
  return MODE_METADATA[normalizeDebateMode(mode)].roleDescriptions[role];
}

export function getDebateInstructionPlaceholder(
  mode: DebateMode | null | undefined,
  role: ActorRole,
) {
  return MODE_METADATA[normalizeDebateMode(mode)].instructionPlaceholders[role];
}

export function getDebateOutputLabels(
  mode: DebateMode | null | undefined,
  role: ActorRole,
) {
  return MODE_METADATA[normalizeDebateMode(mode)].outputLabels[role];
}

export function getOtherParticipantRole(role: ParticipantRole): ParticipantRole {
  return role === "participant_a" ? "participant_b" : "participant_a";
}

export function isWritersRoomMode(mode?: DebateMode | null) {
  return normalizeDebateMode(mode) === "writers_room";
}
