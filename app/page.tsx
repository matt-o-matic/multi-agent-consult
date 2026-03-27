import { Dashboard } from "@/components/dashboard";
import { listRunSummaries } from "@/lib/data/run-store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const runs = await listRunSummaries();

  return <Dashboard initialRuns={runs} />;
}
