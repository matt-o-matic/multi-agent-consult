import { notFound } from "next/navigation";

import { RunSession } from "@/components/run-session";
import { getRunDetail } from "@/lib/data/run-store";
import { runLiveStateStore } from "@/lib/services/live-state";

export const dynamic = "force-dynamic";

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const run = await getRunDetail(id);

  if (!run) {
    notFound();
  }

  return (
    <RunSession
      initialRun={{
        ...run,
        liveState: runLiveStateStore.getSnapshot(id),
      }}
    />
  );
}
