import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { getLastActiveProjectCookieName } from "@/lib/projects/last-active";
import { getProjectDetail } from "@/lib/projects/store";
import { listThreadsForUser } from "@/lib/threads/store";

export default async function WorkspacePage() {
  const [{ organizationId, session }, cookieStore] = await Promise.all([
    requireActiveOrganization(),
    cookies(),
  ]);
  const projectId = cookieStore.get(
    getLastActiveProjectCookieName(organizationId)
  )?.value;
  if (!projectId) redirect("/projects");

  const project = await getProjectDetail({
    projectId,
    organizationId,
    userId: session.user.id,
  }).catch(() => null);
  if (!project) redirect("/projects");

  const [latestThread] = await listThreadsForUser(
    session.user.id,
    organizationId,
    { projectId, limit: 1 }
  );
  redirect(
    latestThread
      ? `/threads/${latestThread.id}`
      : `/projects/${projectId}/threads/new`
  );
}
