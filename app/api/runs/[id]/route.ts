import { NextResponse } from "next/server";

import { getRunDetail } from "@/lib/data/run-store";
import { runLiveStateStore } from "@/lib/services/live-state";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const run = await getRunDetail(id);
  if (!run) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  return NextResponse.json({
    run: {
      ...run,
      liveState: runLiveStateStore.getSnapshot(id),
    },
  });
}
