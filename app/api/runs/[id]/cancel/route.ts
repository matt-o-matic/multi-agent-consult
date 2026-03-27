import { NextResponse } from "next/server";

import { runsManager } from "@/lib/services/runs-manager";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const cancelled = runsManager.cancelRun(id);

  if (!cancelled) {
    return NextResponse.json(
      { error: "Run is not active or cannot be cancelled." },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true });
}
