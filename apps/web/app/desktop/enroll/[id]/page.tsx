import { notFound } from "next/navigation";
import { DesktopEnrollmentApproval } from "./desktop-enrollment-approval";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { knowledgeDb } from "@/lib/knowledge/db";

export default async function DesktopEnrollmentPage(props: {
  params: Promise<{ id: string }>;
}) {
  await requireOrganizationAdmin();
  const { id } = await props.params;
  const request =
    await knowledgeDb.query.desktopEnvironmentEnrollmentRequests.findFirst({
      where: (table, { and, eq, gt }) =>
        and(
          eq(table.id, id),
          eq(table.status, "pending"),
          gt(table.expiresAt, new Date()),
        ),
    });
  if (!request) notFound();
  return (
    <main className="min-h-screen bg-muted/20 px-6 py-16">
      <DesktopEnrollmentApproval
        desktopName={request.desktopName}
        fingerprint={request.fingerprint}
        requestId={request.id}
      />
    </main>
  );
}
