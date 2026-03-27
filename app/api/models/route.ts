import { NextResponse } from "next/server";

import { getAvailableModels } from "@/lib/services/models";

export const runtime = "nodejs";

export async function GET() {
  try {
    const result = await getAvailableModels();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        configured: false,
        models: [],
        errors: [error instanceof Error ? error.message : "Unknown model error"],
      },
      { status: 500 },
    );
  }
}
