import { cookies } from "next/headers";
import { Suspense } from "react";
import { BootstrapChat } from "@/components/chat";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { resolvePreferredLanguageModelId } from "@/lib/ai/gateways";
import { getDefaultOrganizationEnvironment } from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { generateUUID } from "@/lib/utils";

function BootstrapChatFallback() {
  return <div className="min-h-[480px]" />;
}

export default async function ChatIndexPage() {
  const [{ organizationId }, cookieStore] = await Promise.all([
    requireActiveOrganization(),
    cookies(),
  ]);
  const environment = await getDefaultOrganizationEnvironment(organizationId);
  const modelIdFromCookie = cookieStore.get("chat-model");
  const id = generateUUID();
  const initialChatModel = await resolvePreferredLanguageModelId(
    modelIdFromCookie?.value,
    null,
    organizationId,
    environment?.id
  );

  return (
    <>
      <Suspense fallback={<BootstrapChatFallback />}>
        <BootstrapChat
          activeEnvironment={environment ? { id: environment.id, name: environment.name } : undefined}
          id={id}
          initialChatModel={initialChatModel}
          key={id}
        />
      </Suspense>
      <DataStreamHandler threadId={id} />
    </>
  );
}
