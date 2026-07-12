import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Response } from "@/components/chatbot/elements/response";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createMetadata } from "@/lib/metadata";
import { publicAppUrl } from "@/lib/public-config";
import { getPublicThreadByShareToken } from "@/lib/threads/store";
import { convertToUIMessages } from "@/lib/utils";

const getSharedThread = cache(getPublicThreadByShareToken);

type SharedThreadPageProps = {
  params: Promise<{ token: string }>;
};

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

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-4 py-8">
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
        {messages.map((message) => (
          <Card key={message.id}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base capitalize">
                {message.role}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {message.parts?.map((part, index) => {
                if (part.type === "text") {
                  return (
                    <Response key={`${message.id}-${index}`}>
                      {part.text}
                    </Response>
                  );
                }

                if (part.type === "reasoning" && part.text?.trim()) {
                  return (
                    <div
                      className="rounded-lg border bg-muted/30 p-3 text-sm"
                      key={`${message.id}-${index}`}
                    >
                      <div className="mb-1 font-medium">Reasoning</div>
                      <Response>{part.text}</Response>
                    </div>
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
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
