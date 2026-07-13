import { notFound } from "next/navigation";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { getThreadAccessForUser } from "@/lib/threads/store";
import { WorkspaceClient } from "./workspace-client";

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { organizationId, session } = await requireActiveOrganization();
  if (!(await getThreadAccessForUser(id, session.user.id, organizationId))) {
    notFound();
  }
  return <WorkspaceClient threadId={id} />;
}
