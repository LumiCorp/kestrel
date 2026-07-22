import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Response } from "@/components/chatbot/elements/response";
import { BrandLockup } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createMetadata } from "@/lib/metadata";
import { publicAppUrl } from "@/lib/public-config";
import { getPublicThreadByShareToken } from "@/lib/threads/store";
import { projectThreadConversation } from "@/lib/turns/conversation-projector";
import type { ChatMessage } from "@/lib/types";
import { convertToUIMessages } from "@/lib/utils";

const getSharedThread = cache(getPublicThreadByShareToken);

type SharedThreadPageProps = {
  params: Promise<{ token: string }>;
};

function SharedMessageCard({ message }: { message: ChatMessage }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base capitalize">{message.role}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {message.parts?.map((part, index) => {
          if (part.type === "text") {
            return (
              <Response key={`${message.id}-${index}`}>{part.text}</Response>
            );
          }

          if (part.type === "file") {
            return (
              <div className="text-sm" key={`${message.id}-${index}`}>
                Attachment:{" "}
                <a
                  className="text-primary underline"
                  href={part.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  {part.filename || "file"}
                </a>
              </div>
            );
          }

          if (part.type === "data-kestrel-dialog-message") {
            return (
              <div className="text-sm" key={`${message.id}-${index}`}>
                <div className="mb-1 font-medium">
                  {part.data.sender === "collaborator" ? part.data.name : part.data.sender === "kestrel" ? "Kestrel" : "System"}
                </div>
                <div className="whitespace-pre-wrap">{part.data.text}</div>
              </div>
            );
          }

          return null;
        })}
      </CardContent>
    </Card>
  );
}

export async function generateMetadata({
  params,
}: SharedThreadPageProps): Promise<Metadata> {
  const { token } = await params;
  const thread = await getSharedThread(token);
  const title = thread?.title?.trim() || "Shared Thread";
  const routeUrl = publicAppUrl ? `${publicAppUrl}/shared/${token}` : undefined;

  return createMetadata({
    title,
    description: "Open a read-only shared conversation from Kestrel One.",
    alternates: routeUrl
      ? {
          canonical: routeUrl,
        }
      : undefined,
    openGraph: routeUrl
      ? {
          url: routeUrl,
        }
      : undefined,
  });
}

export default async function SharedThreadPage(props: SharedThreadPageProps) {
  const { token } = await props.params;
  const thread = await getSharedThread(token);

  if (!thread) {
    notFound();
  }

  const messages = convertToUIMessages(thread.messages);
  const projection = projectThreadConversation({
    messages,
    conversationState: {
      interactions: [],
      turns: thread.turns.map((turn) => ({
        ...turn,
        failureCode: null,
        failureMessage: null,
        cancelRequestedAt: null,
        startedAt: turn.startedAt?.toISOString() ?? null,
        finishedAt: turn.finishedAt?.toISOString() ?? null,
        createdAt: turn.createdAt.toISOString(),
        updatedAt: turn.updatedAt.toISOString(),
      })),
      queue: {
        state: "running",
        pauseReason: null,
        activeTurnId: null,
        version: 0,
      },
    },
  });

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-4 py-8">
      <Link
        aria-label="Kestrel One home"
        className="inline-flex w-fit rounded-sm outline-none ring-ring focus-visible:ring-2 focus-visible:ring-offset-2"
        href="/"
      >
        <BrandLockup decorative height={20} />
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-2">
          <Badge variant="outline">Shared Thread</Badge>
          <h1 className="font-semibold text-3xl">
            {thread.title || "Shared Thread"}
          </h1>
          <p className="text-muted-foreground text-sm">
            Read-only, anonymized transcript shared from Kestrel One.
          </p>
        </div>
        <Button asChild>
          <Link href="/threads/new">Start Your Own Thread</Link>
        </Button>
      </div>

      <div className="space-y-4">
        {projection.items.map((item) =>
          item.kind === "standalone_message" ? (
            <SharedMessageCard key={item.id} message={item.message} />
          ) : (
            <section
              aria-label={`Conversation turn ${item.turn?.sequence ?? ""}`.trim()}
              className="space-y-3 rounded-xl border border-border/60 p-3"
              data-turn-id={item.turnId}
              key={item.id}
            >
              <div className="text-muted-foreground text-xs capitalize">
                Turn {item.turn?.status.replaceAll("_", " ") ?? "recorded"}
              </div>
              {item.messages.map((message) => (
                <SharedMessageCard key={message.id} message={message} />
              ))}
            </section>
          )
        )}
      </div>
    </div>
  );
}
