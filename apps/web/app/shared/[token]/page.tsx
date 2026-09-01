import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Response } from "@/components/chatbot/elements/response";
import { BrandLockup } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { createMetadata } from "@/lib/metadata";
import { publicAppUrl } from "@/lib/public-config";
import { getPublicThreadByShareToken } from "@/lib/threads/store";
import { projectThreadConversation } from "@/lib/turns/conversation-projector";
import { withoutWebCollaboratorMessages } from "@/lib/turns/collaborators";
import type { ChatMessage } from "@/lib/types";
import { PageContainer } from "@/components/app-page";
import { convertToUIMessages } from "@/lib/utils";

const getSharedThread = cache(getPublicThreadByShareToken);

type SharedThreadPageProps = {
  params: Promise<{ token: string }>;
};

function SharedTranscriptMessage({ message }: { message: ChatMessage }) {
  return (
    <article className="grid gap-2 border-t py-5 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-5">
      <div className="font-medium text-muted-foreground text-xs capitalize">
        {message.role === "assistant" ? "Kestrel" : message.role}
      </div>
      <div className="min-w-0 space-y-3">
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

          return null;
        })}
      </div>
    </article>
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

  const messages = withoutWebCollaboratorMessages(convertToUIMessages(thread.messages));
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
    <PageContainer
      className="min-h-screen py-8"
      contentClassName="flex max-w-3xl flex-col gap-6"
    >
      <Link
        aria-label="Kestrel One home"
        className="inline-flex w-fit rounded-sm outline-none ring-ring focus-visible:ring-2 focus-visible:ring-offset-2"
        href="/"
      >
        <BrandLockup decorative height={20} />
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-2">
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.18em]">
            Shared Thread
          </p>
          <h1 className="font-semibold text-3xl">
            {thread.title || "Shared Thread"}
          </h1>
          <p className="text-muted-foreground text-sm">
            Read-only, anonymized transcript shared from Kestrel One.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/threads/new">Start Your Own Thread</Link>
        </Button>
      </div>

      <div className="space-y-4">
        {projection.items.map((item) =>
          item.kind === "standalone_message" ? (
            <SharedTranscriptMessage key={item.id} message={item.message} />
          ) : (
            <section
              aria-label={`Conversation turn ${item.turn?.sequence ?? ""}`.trim()}
              className="space-y-0"
              data-turn-id={item.turnId}
              key={item.id}
            >
              {item.turn?.status && item.turn.status !== "completed" ? (
                <div className="border-amber-600 border-l-2 py-1 pl-3 text-muted-foreground text-xs capitalize">
                  Turn {item.turn.status.replaceAll("_", " ")}
                </div>
              ) : null}
              {item.messages.map((message) => (
                <SharedTranscriptMessage key={message.id} message={message} />
              ))}
            </section>
          ),
        )}
      </div>
    </PageContainer>
  );
}
