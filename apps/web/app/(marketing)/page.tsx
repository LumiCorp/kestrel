import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LandingPage } from "@/components/marketing/landing-page";
import { getLastActiveProjectCookieName } from "@/lib/projects/last-active";
import { getProjectDetail } from "@/lib/projects/store";
import { listThreadsForUser } from "@/lib/threads/store";
import { createMetadata } from "@/lib/metadata";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { auth } from "../(auth)/auth";

export const metadata = createMetadata({
  title: {
    absolute: "Kestrel — Open a project and put an agent to work",
  },
  description:
    "Open a project, choose a model, and ask Kestrel to build software, research questions, analyze data, and produce reports, spreadsheets, presentations, and other files.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    siteName: "Kestrel",
    type: "website",
    url: "/",
  },
});

async function redirectAuthenticatedUser() {
  const [{ organizationId, session }, cookieStore] = await Promise.all([
    requireActiveOrganization(),
    cookies(),
  ]);
  const projectId = cookieStore.get(
    getLastActiveProjectCookieName(organizationId),
  )?.value;

  if (!projectId) {
    redirect("/projects");
  }

  const project = await getProjectDetail({
    projectId,
    organizationId,
    userId: session.user.id,
  }).catch(() => null);

  if (!project) {
    redirect("/projects");
  }

  const [latestThread] = await listThreadsForUser(
    session.user.id,
    organizationId,
    { projectId, limit: 1 },
  );

  redirect(
    latestThread
      ? `/threads/${latestThread.id}`
      : `/projects/${projectId}/threads/new`,
  );
}

export default async function Page() {
  const session = await auth();

  if (session?.user) {
    await redirectAuthenticatedUser();
  }

  return <LandingPage />;
}
