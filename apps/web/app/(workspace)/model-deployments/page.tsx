import { AppPage } from "@/components/app-page";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { ManagedRunPodDeploymentsClient } from "./page-client";

export default async function ModelDeploymentsPage() {
  await requireActiveOrganization();
  return (
    <AppPage className="mx-auto w-full max-w-6xl p-6">
      <ManagedRunPodDeploymentsClient />
    </AppPage>
  );
}
