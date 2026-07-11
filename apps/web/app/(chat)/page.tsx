import { cookies } from "next/headers";
import { Suspense } from "react";
import { BootstrapChat } from "@/components/chat";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { resolvePreferredLanguageModelId } from "@/lib/ai/gateways";
import { generateUUID } from "@/lib/utils";

export default function Page() {
  return (
    <Suspense fallback={<div className="flex h-dvh" />}>
      <NewChatPage />
    </Suspense>
  );
}

async function NewChatPage() {
  const cookieStore = await cookies();
  const modelIdFromCookie = cookieStore.get("chat-model");
  const id = generateUUID();
  const initialChatModel = await resolvePreferredLanguageModelId(
    modelIdFromCookie?.value
  );

  return (
    <>
      <BootstrapChat id={id} initialChatModel={initialChatModel} key={id} />
      <DataStreamHandler chatId={id} />
    </>
  );
}
