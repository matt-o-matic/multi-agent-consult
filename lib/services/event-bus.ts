import type { RunEvent } from "@/lib/types";

type Listener = (event: RunEvent) => void;

class RunEventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(runId: string, listener: Listener) {
    const existing = this.listeners.get(runId) ?? new Set<Listener>();
    existing.add(listener);
    this.listeners.set(runId, existing);

    return () => {
      const scopedListeners = this.listeners.get(runId);
      if (!scopedListeners) {
        return;
      }
      scopedListeners.delete(listener);
      if (scopedListeners.size === 0) {
        this.listeners.delete(runId);
      }
    };
  }

  publish(event: RunEvent) {
    const listeners = this.listeners.get(event.runId);
    if (!listeners) {
      return;
    }
    listeners.forEach((listener) => listener(event));
  }
}

declare global {
  var __multiAgentEventBus: RunEventBus | undefined;
}

export const runEventBus = global.__multiAgentEventBus ?? new RunEventBus();

if (!global.__multiAgentEventBus) {
  global.__multiAgentEventBus = runEventBus;
}
