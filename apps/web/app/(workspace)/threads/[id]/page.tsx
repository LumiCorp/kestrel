import { cookies } from "next/headers";
import { Suspense } from "react";

import { Chat } from "@/components/chat";
import { ThreadRouteLoading } from "@/components/chatbot/thread-route-loading";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { ThreadReadMarker } from "@/components/threads/thread-read-marker";
import { resolvePreferredLanguageModelId } from "@/lib/ai/gateways";
import { describeEnvironmentActivation } from "@/lib/environments/execution-route";
import {
  getDefaultOrganizationEnvironment,
  getThreadExecutionBindingState,
  resolveThreadEnvironment,
} from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { getOrganizationChatReadiness } from "@/lib/organizations/chat-readiness";
import { getProjectDetail, listProjectsForUser } from "@/lib/projects/store";
import { readThreadConversationSnapshotForUser } from "@/lib/turns/conversation-snapshot.server";

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
  const conversationRead = await readThreadConversationSnapshotForUser({
    threadId: id,
    userId: session.user.id,
    organizationId,
    includeArchived: true,
  });
  const chat = conversationRead?.thread ?? null;
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
  const [
    projectDetail,
    projectRows,
    readiness,
    executionBindingState,
  ] =
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
      getOrganizationChatReadiness(organizationId),
      chat
        ? getThreadExecutionBindingState({
            organizationId,
            threadId: chat.id,
          })
        : Promise.resolve(null),
    ]);
  const initialConversationSnapshot = conversationRead?.snapshot ?? {
    messages: [],
    interactions: [],
    turns: [],
    queue: {
      state: "running" as const,
      pauseReason: null,
      activeTurnId: null,
      version: 0,
    },
  };
  const environmentActivation = executionBindingState
    ? describeEnvironmentActivation({
        environmentStatus: executionBindingState.environment.status,
        workspaceStatus: executionBindingState.workspace.status,
        failureMessage:
          executionBindingState.workspace.failureMessage ??
          executionBindingState.environment.failureMessage,
      })
    : null;

  return (
    <>
      <Chat
        activeEnvironment={
          environment
            ? { id: environment.id, name: environment.name }
            : undefined
        }
        environmentProvisioningNotice={
          executionBindingState && environmentActivation?.status === "pending"
            ? {
                detail: environmentActivation.detail,
                environmentName: executionBindingState.environment.name,
                environmentStatus: executionBindingState.environment.status,
                stage: environmentActivation.stage,
                workspaceStatus: executionBindingState.workspace.status,
              }
            : null
        }
        archived={Boolean(chat?.archivedAt)}
        canManage={chat?.access.canManage ?? false}
        canPublish={chat?.access.canPublish ?? false}
        id={chat?.id ?? id}
        initialChatExists={Boolean(chat)}
        initialChatModel={initialChatModel}
        initialInteractionMode={chat?.interactionMode ?? "chat"}
        initialConversationSnapshot={initialConversationSnapshot}
        initialMessages={initialConversationSnapshot.messages}
        initialShareToken={chat?.shareToken ?? null}
        initialVisibilityType={chat?.isPublic ? "public" : "private"}
        isReadonly={Boolean(chat?.archivedAt)}
        newTurnDisabledReason={
          readiness.applicable && !readiness.ready
            ? "Finish organization setup before starting a new agent turn."
            : undefined
        }
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
        threadTitle={chat?.title || "New Thread"}
      />
      {chat && (
        chat.messages.at(-1)?.id ? (
          <ThreadReadMarker
            messageId={chat.messages.at(-1)!.id}
            threadId={chat.id}
          />
        ) : null
      )}
      <DataStreamHandler threadId={chat?.id ?? id} />
    </>
  );
}
