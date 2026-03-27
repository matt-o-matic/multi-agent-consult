import { NextResponse } from "next/server";

import { hasActiveRun } from "@/lib/data/run-store";
import { runsManager } from "@/lib/services/runs-manager";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  if (await hasActiveRun()) {
    return NextResponse.json(
      { error: "Only one active run is supported in v1." },
      { status: 409 },
    );
  }

  try {
    const run = await runsManager.retryRun(id);
    if (!run) {
      throw new Error("Run could not be retried.");
    }

    return NextResponse.json({ run });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Run retry failed.",
      },
      { status: 400 },
    );
  }
}
