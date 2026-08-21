import { notFound } from "next/navigation";
import { KubernetesEnrollmentApproval } from "@/components/organization/kubernetes-enrollment-approval";
import { getKubernetesConnectorEnrollment } from "@/lib/environments/kubernetes-connector";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function KubernetesEnrollmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { organizationId } = await requireOrganizationAdmin();
  const { id } = await params;
  const enrollment = await getKubernetesConnectorEnrollment({
    requestId: id,
    organizationId,
  }).catch(() => null);
  if (!enrollment) notFound();
  return <KubernetesEnrollmentApproval enrollment={enrollment} />;
}
