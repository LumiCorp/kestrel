import { cookies } from "next/headers";
import { Suspense } from "react";

import { Chat } from "@/components/chat";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { getChatWithMessagesForUser } from "@/lib/agent/store";
import { resolvePreferredLanguageModelId } from "@/lib/ai/gateways";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
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
  const chat = await getChatWithMessagesForUser(
    id,
    session.user.id,
    organizationId
  );

  const cookieStore = await cookies();
  const chatModelFromCookie = cookieStore.get("chat-model");
  const initialChatModel = await resolvePreferredLanguageModelId(
    chatModelFromCookie?.value
  );
  const uiMessages = chat ? convertToUIMessages(chat.messages) : [];

  return (
    <>
      <Chat
        id={chat?.id ?? id}
        initialChatExists={Boolean(chat)}
        initialChatModel={initialChatModel}
        initialMessages={uiMessages}
        initialShareToken={chat?.shareToken ?? null}
        initialVisibilityType={chat?.isPublic ? "public" : "private"}
        isReadonly={false}
      />
      <DataStreamHandler chatId={chat?.id ?? id} />
    </>
  );
}
