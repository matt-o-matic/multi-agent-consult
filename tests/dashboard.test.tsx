import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { Dashboard } from "@/components/dashboard";
import type { RunSummary } from "@/lib/types";

vi.mock("next/link", () => ({
  default: function MockLink({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  }) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

const now = new Date().toISOString();

const runs: RunSummary[] = [
  {
    id: "run-1",
    taskPrompt: "Polish this essay.",
    status: "completed",
    stopReason: "converged",
    debateMode: "writers_room",
    createdAt: now,
    updatedAt: now,
    participantA: {
      role: "participant_a",
      modelId: "alpha",
      provider: "openrouter",
      label: "Writer",
    },
    participantB: {
      role: "participant_b",
      modelId: "beta",
      provider: "openrouter",
      label: "Editor",
    },
    referee: {
      role: "referee",
      modelId: "gamma",
      provider: "openrouter",
      label: "Referee",
    },
  },
];

describe("Dashboard", () => {
  it("renders mode-aware writer and editor labels from the latest run", () => {
    const html = renderToStaticMarkup(<Dashboard initialRuns={runs} />);

    expect(html).toContain("Writer&#x27;s room");
    expect(html).toContain("Writer");
    expect(html).toContain("Editor");
    expect(html).toContain("Mode");
  });
});
