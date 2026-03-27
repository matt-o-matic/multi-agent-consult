import type { LiveTurnState, RunEvent, RunLiveState } from "@/lib/types";

function liveTurnKey(args: {
  role: LiveTurnState["role"];
  phase: LiveTurnState["phase"];
  turnIndex: number;
}) {
  return `${args.role}:${args.phase}:${args.turnIndex}`;
}

interface MutableRunLiveState {
  activeTurns: Map<string, LiveTurnState>;
  latestStatusMessage: string | null;
  updatedAt: string | null;
}

class RunLiveStateStore {
  private states = new Map<string, MutableRunLiveState>();

  private ensure(runId: string) {
    const existing = this.states.get(runId);
    if (existing) {
      return existing;
    }

    const created: MutableRunLiveState = {
      activeTurns: new Map(),
      latestStatusMessage: null,
      updatedAt: null,
    };
    this.states.set(runId, created);
    return created;
  }

  applyEvent(event: RunEvent) {
    const state = this.ensure(event.runId);
    state.updatedAt = event.at;

    if (event.type === "status") {
      state.latestStatusMessage = event.message ?? state.latestStatusMessage;

      if (["completed", "failed", "cancelled"].includes(event.status)) {
        state.activeTurns.clear();
      }
      return;
    }

    if (event.type === "turn_started") {
      state.activeTurns.set(
        liveTurnKey(event),
        {
          content: "",
          modelId: event.modelId,
          phase: event.phase,
          role: event.role,
          startedAt: event.at,
          turnIndex: event.turnIndex,
          updatedAt: event.at,
        },
      );
      return;
    }

    if (event.type === "turn_delta") {
      state.activeTurns.set(
        liveTurnKey(event),
        {
          content: event.content,
          modelId: event.modelId,
          phase: event.phase,
          role: event.role,
          startedAt: state.activeTurns.get(liveTurnKey(event))?.startedAt ?? event.at,
          turnIndex: event.turnIndex,
          updatedAt: event.at,
        },
      );
      return;
    }

    if (event.type === "turn_completed") {
      state.activeTurns.delete(
        liveTurnKey({
          role: event.turn.role,
          phase: event.turn.phase,
          turnIndex: event.turn.turnIndex,
        }),
      );
      return;
    }

    if (event.type === "completed") {
      state.activeTurns.clear();
    }
  }

  getSnapshot(runId: string): RunLiveState | null {
    const state = this.states.get(runId);
    if (!state) {
      return null;
    }

    return {
      activeTurns: [...state.activeTurns.values()].sort((left, right) =>
        left.startedAt.localeCompare(right.startedAt),
      ),
      latestStatusMessage: state.latestStatusMessage,
      updatedAt: state.updatedAt,
    };
  }
}

declare global {
  var __multiAgentLiveStateStore: RunLiveStateStore | undefined;
}

export const runLiveStateStore =
  global.__multiAgentLiveStateStore ?? new RunLiveStateStore();

if (!global.__multiAgentLiveStateStore) {
  global.__multiAgentLiveStateStore = runLiveStateStore;
}
