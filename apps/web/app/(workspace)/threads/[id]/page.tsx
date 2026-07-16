import { cookies } from "next/headers";
import { Suspense } from "react";

import { Chat } from "@/components/chat";
import { ThreadRouteLoading } from "@/components/chatbot/thread-route-loading";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { ThreadActions } from "@/components/threads/thread-actions";
import { resolvePreferredLanguageModelId } from "@/lib/ai/gateways";
import {
  getDefaultOrganizationEnvironment,
  resolveThreadEnvironment,
} from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { getProjectDetail, listProjectsForUser } from "@/lib/projects/store";
import { getThreadWithMessagesForUser } from "@/lib/threads/store";
import {
  listDurableThreadQueueForUser,
  listThreadInteractionsForUser,
} from "@/lib/turns/store";
import { convertToUIMessages } from "@/lib/utils";

export default async function Page(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return (
    <Suspense fallback={<ThreadRouteLoading threadId={id} />}>
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
  const [cookieStore, environment] = await Promise.all([
    cookies(),
    chat
      ? resolveThreadEnvironment({ organizationId, threadId: chat.id })
      : getDefaultOrganizationEnvironment(organizationId),
  ]);
  const chatModelFromCookie = cookieStore.get("chat-model");
  const initialChatModel = await resolvePreferredLanguageModelId(
    chatModelFromCookie?.value,
    null,
    organizationId,
    environment?.id
  );
  const [projectDetail, projectRows, durableState, interactions] =
    await Promise.all([
      chat?.projectId
        ? getProjectDetail({
            projectId: chat.projectId,
            organizationId,
            userId: session.user.id,
            includeArchived: true,
          })
        : Promise.resolve(null),
      listProjectsForUser({ organizationId, userId: session.user.id }),
      chat
        ? listDurableThreadQueueForUser({
            threadId: chat.id,
            organizationId,
            userId: session.user.id,
          })
        : Promise.resolve(null),
      chat
        ? listThreadInteractionsForUser({
            threadId: chat.id,
            organizationId,
            userId: session.user.id,
          })
        : Promise.resolve([]),
    ]);
  const uiMessages = chat ? convertToUIMessages(chat.messages) : [];

  return (
    <>
      <Chat
        activeEnvironment={
          environment
            ? { id: environment.id, name: environment.name }
            : undefined
        }
        canPublish={chat?.access.canPublish ?? false}
        id={chat?.id ?? id}
        initialChatExists={Boolean(chat)}
        initialChatModel={initialChatModel}
        initialConversationState={{
          interactions: interactions.map((interaction) => ({
            ...interaction,
            createdAt: interaction.createdAt.toISOString(),
            resolvedAt: interaction.resolvedAt?.toISOString() ?? null,
          })),
          turns: (durableState?.turns ?? []).map((turn) => ({
            id: turn.id,
            sequence: turn.sequence,
            inputMessageId: turn.inputMessageId,
            status: turn.status,
            failureCode: turn.failureCode,
            failureMessage: turn.failureMessage,
            cancelRequestedAt: turn.cancelRequestedAt?.toISOString() ?? null,
            startedAt: turn.startedAt?.toISOString() ?? null,
            finishedAt: turn.finishedAt?.toISOString() ?? null,
            createdAt: turn.createdAt.toISOString(),
            updatedAt: turn.updatedAt.toISOString(),
          })),
          queue: durableState
            ? {
                ...durableState.queue,
                pauseReason:
                  durableState.queue.pauseReason === "turn_failed" ||
                  durableState.queue.pauseReason === "turn_cancelled" ||
                  durableState.queue.pauseReason === "interaction_required"
                    ? durableState.queue.pauseReason
                    : null,
              }
            : {
                state: "running",
                pauseReason: null,
                activeTurnId: null,
                version: 0,
              },
        }}
        initialMessages={uiMessages}
        initialShareToken={chat?.shareToken ?? null}
        initialVisibilityType={chat?.isPublic ? "public" : "private"}
        isReadonly={Boolean(chat?.archivedAt)}
        project={
          projectDetail
            ? {
                id: projectDetail.project.id,
                name: projectDetail.project.name,
              }
            : null
        }
        threadTitle={chat?.title || "New Thread"}
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
