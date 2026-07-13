import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BootstrapChat } from "@/components/chat";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { resolvePreferredLanguageModelId } from "@/lib/ai/gateways";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
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
  const threadId = generateUUID();
  const modelIdFromCookie = cookieStore.get("chat-model");
  const initialChatModel = await resolvePreferredLanguageModelId(
    modelIdFromCookie?.value,
    null,
    organizationId
  );
  return (
    <>
      <Suspense fallback={<div className="min-h-[480px]" />}>
        <BootstrapChat
          id={threadId}
          initialChatModel={initialChatModel}
          key={threadId}
          projectId={projectId}
        />
      </Suspense>
      <DataStreamHandler threadId={threadId} />
    </>
  );
}
