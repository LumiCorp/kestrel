import { cookies } from "next/headers";
import { Suspense } from "react";

import { Chat } from "@/components/chat";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { ThreadActions } from "@/components/threads/thread-actions";
import { resolvePreferredLanguageModelId } from "@/lib/ai/gateways";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { getProjectDetail, listProjectsForUser } from "@/lib/projects/store";
import { getThreadWithMessagesForUser } from "@/lib/threads/store";
import { convertToUIMessages } from "@/lib/utils";

export default function Page(props: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="flex h-dvh" />}>
      <ChatPage params={props.params} />
    </Suspense>
  );
}

async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { session, organizationId } = await requireActiveOrganization();
  const chat = await getThreadWithMessagesForUser(
    id,
    session.user.id,
    organizationId,
    true
  );
  const cookieStore = await cookies();
  const chatModelFromCookie = cookieStore.get("chat-model");
  const initialChatModel = await resolvePreferredLanguageModelId(
    chatModelFromCookie?.value
  );
  const [projectDetail, projectRows] = await Promise.all([
    chat?.projectId
      ? getProjectDetail({
          projectId: chat.projectId,
          organizationId,
          userId: session.user.id,
          includeArchived: true,
        })
      : Promise.resolve(null),
    listProjectsForUser({ organizationId, userId: session.user.id }),
  ]);
  const uiMessages = chat ? convertToUIMessages(chat.messages) : [];

  return (
    <>
      <Chat
        canPublish={chat?.access.canPublish ?? false}
        id={chat?.id ?? id}
        initialChatExists={Boolean(chat)}
        initialChatModel={initialChatModel}
        initialMessages={uiMessages}
        initialShareToken={chat?.shareToken ?? null}
        initialVisibilityType={chat?.isPublic ? "public" : "private"}
        isReadonly={Boolean(chat?.archivedAt)}
      />
      {chat && (
        <ThreadActions
          archived={Boolean(chat.archivedAt)}
          canManage={chat.access.canManage}
          initialTitle={chat.title || "New thread"}
          project={
            projectDetail
              ? {
                  id: projectDetail.project.id,
                  name: projectDetail.project.name,
                }
              : null
          }
          projects={projectRows.map(({ project }) => ({
            id: project.id,
            name: project.name,
          }))}
          threadId={chat.id}
        />
      )}
      <DataStreamHandler threadId={chat?.id ?? id} />
    </>
  );
}
