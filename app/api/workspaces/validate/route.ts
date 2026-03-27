import { NextResponse } from "next/server";

import { validateWorkspacePath } from "@/lib/services/workspace-tools";
import { workspaceValidationSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const payload = workspaceValidationSchema.parse(await request.json());
    const manifest = await validateWorkspacePath(payload.workspacePath);
    return NextResponse.json({ manifest });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Invalid workspace request.",
      },
      { status: 400 },
    );
  }
}
