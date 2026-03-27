import { NextResponse } from "next/server";

import { createRun, hasActiveRun, listRunSummaries } from "@/lib/data/run-store";
import { getServerEnv } from "@/lib/env";
import { validateRunConfig } from "@/lib/services/models";
import { runsManager } from "@/lib/services/runs-manager";
import { validateWorkspacePath } from "@/lib/services/workspace-tools";
import type { RunConfig } from "@/lib/types";
import { normalizeParticipantConfig, runConfigSchema } from "@/lib/validation";

export const runtime = "nodejs";

function normalizeRunConfig(input: RunConfig) {
  return {
    ...input,
    workspacePath: input.workspacePath?.trim() || null,
    participantA: normalizeParticipantConfig(input.participantA),
    participantB: normalizeParticipantConfig(input.participantB),
    referee: normalizeParticipantConfig(input.referee),
  } satisfies RunConfig;
}

export async function GET() {
  const runs = await listRunSummaries();
  return NextResponse.json({ runs });
}

export async function POST(request: Request) {
  try {
    if (await hasActiveRun()) {
      return NextResponse.json(
        { error: "Only one active run is supported in v1." },
        { status: 409 },
      );
    }

    const parsed = runConfigSchema.parse(await request.json());
    const config = normalizeRunConfig(parsed as RunConfig);

    if (config.workspaceMode === "path" && !config.workspacePath) {
      return NextResponse.json(
        { error: "workspacePath is required when workspaceMode is path." },
        { status: 400 },
      );
    }

    const { braveSearchApiKey } = getServerEnv();
    if (config.searchBackend === "brave" && !braveSearchApiKey) {
      return NextResponse.json(
        { error: "BRAVE_SEARCH_API_KEY is not configured." },
        { status: 400 },
      );
    }

    const { errors } = await validateRunConfig(config);
    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join(" ") }, { status: 400 });
    }

    const workspaceManifest =
      config.workspaceMode === "path" && config.workspacePath
        ? await validateWorkspacePath(config.workspacePath)
        : null;

    const runId = crypto.randomUUID();
    const run = await createRun(runId, config);
    if (!run) {
      throw new Error("Run could not be created.");
    }

    await runsManager.startRun({
      runId,
      config,
      workspaceManifest,
    });

    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Run creation failed.",
      },
      { status: 400 },
    );
  }
}
