import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BootstrapChat } from "@/components/chat";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { resolvePreferredLanguageModelId } from "@/lib/ai/gateways";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { getOrganizationChatReadiness } from "@/lib/organizations/chat-readiness";
import { requireProjectRole } from "@/lib/projects/access";
import { generateUUID } from "@/lib/utils";

export default async function NewProjectThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = await params;
  const [{ organizationId, session }, cookieStore] = await Promise.all([
    requireActiveOrganization(),
    cookies(),
  ]);
  const access = await requireProjectRole({
    projectId,
    organizationId,
    userId: session.user.id,
  }).catch(() => null);
  if (!access) notFound();
  const environment = await getOrganizationEnvironment({
    organizationId,
    environmentId: access.project.environmentId,
  });
  const readiness = await getOrganizationChatReadiness(organizationId);
  const threadId = generateUUID();
  const modelIdFromCookie = cookieStore.get("chat-model");
  const initialChatModel = await resolvePreferredLanguageModelId(
    modelIdFromCookie?.value,
    null,
    organizationId,
    environment?.id
  );
  return (
    <>
      <Suspense fallback={<div className="min-h-[480px]" />}>
        <BootstrapChat
          activeEnvironment={
            environment
              ? { id: environment.id, name: environment.name }
              : undefined
          }
          id={threadId}
          initialChatModel={initialChatModel}
          key={threadId}
          newTurnDisabledReason={
            readiness.applicable && !readiness.ready
              ? "Finish organization setup before starting a new agent turn."
              : undefined
          }
          projectId={projectId}
          projectName={access.project.name}
        />
      </Suspense>
      <DataStreamHandler threadId={threadId} />
    </>
  );
}
