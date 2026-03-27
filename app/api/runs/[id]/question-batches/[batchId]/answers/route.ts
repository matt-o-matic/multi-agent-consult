import { NextResponse } from "next/server";

import { runsManager } from "@/lib/services/runs-manager";
import { questionBatchAnswerSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; batchId: string }> },
) {
  try {
    const payload = questionBatchAnswerSchema.parse(await request.json());
    const { id, batchId } = await context.params;
    const batch = await runsManager.answerQuestionBatch(id, batchId, payload.answers);
    return NextResponse.json({ batch });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not answer question batch.",
      },
      { status: 400 },
    );
  }
}
