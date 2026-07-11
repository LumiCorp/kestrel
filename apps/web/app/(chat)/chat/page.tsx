import { cookies } from "next/headers";
import { Suspense } from "react";
import { BootstrapChat } from "@/components/chat";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { resolvePreferredLanguageModelId } from "@/lib/ai/gateways";
import { generateUUID } from "@/lib/utils";

function BootstrapChatFallback() {
  return <div className="min-h-[480px]" />;
}

export default async function ChatIndexPage() {
  const cookieStore = await cookies();
  const modelIdFromCookie = cookieStore.get("chat-model");
  const id = generateUUID();
  const initialChatModel = await resolvePreferredLanguageModelId(
    modelIdFromCookie?.value
  );

  return (
    <>
      <Suspense fallback={<BootstrapChatFallback />}>
        <BootstrapChat id={id} initialChatModel={initialChatModel} key={id} />
      </Suspense>
      <DataStreamHandler chatId={id} />
    </>
  );
}
