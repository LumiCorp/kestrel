"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { parseUrlElicitation } from "@/lib/mcp/interaction-protocol";
import type { ThreadInteractionView } from "@/lib/turns/client-contract";

export type RuntimeInteractionResponse = {
  requestId: string;
  eventType: string;
  message: string;
  approved?: boolean | undefined;
  reason?: string | undefined;
};

export function InteractionPanel({
  threadId,
  interactions,
  onRuntimeResponse,
  onResolved,
  embedded = false,
}: {
  threadId: string;
  interactions: ThreadInteractionView[];
  onRuntimeResponse: (response: RuntimeInteractionResponse) => Promise<void>;
  onResolved: () => Promise<void>;
  embedded?: boolean;
}) {
  const [content, setContent] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const firstControlRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    firstControlRef.current?.focus();
  }, [interactions[0]?.requestId]);

  async function resolveRuntime(
    interaction: ThreadInteractionView,
    decision?: boolean
  ) {
    const answer = content[interaction.requestId]?.trim();
    const message =
      interaction.kind === "approval"
        ? decision
          ? "Approved"
          : "Denied"
        : answer;
    if (!message) {
      setError("Enter a response before continuing.");
      return;
    }
    setBusy(interaction.requestId);
    setError(null);
    try {
      await onRuntimeResponse({
        requestId: interaction.requestId,
        eventType: interaction.eventType,
        message,
        ...(interaction.kind === "approval" ? { approved: decision } : {}),
      });
      await onResolved();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The response could not be sent."
      );
    } finally {
      setBusy(null);
    }
  }

  async function resolveMcp(
    interaction: ThreadInteractionView,
    decision: "approve" | "deny"
  ) {
    const checkpointId = interaction.sourceCheckpointId;
    if (!checkpointId) {
      setError("The App interaction checkpoint is missing.");
      return;
    }
    setBusy(interaction.requestId);
    setError(null);
    try {
      let parsedContent: Record<string, unknown> | undefined;
      if (
        interaction.kind === "mcp_elicitation" &&
        decision === "approve" &&
        !parseUrlElicitation(interaction.requestEnvelope)
      ) {
        parsedContent = JSON.parse(
          content[interaction.requestId] || "{}"
        ) as Record<string, unknown>;
      }
      const response = await fetch(
        `/api/threads/${threadId}/mcp/interactions/${checkpointId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision, content: parsedContent }),
        }
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          payload.error ?? "The App request could not be resolved."
        );
      }
      await onResolved();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The App request could not be resolved."
      );
    } finally {
      setBusy(null);
    }
  }

  const visibleInteractions = interactions.filter(
    (interaction) =>
      !(interaction.source === "runtime" && interaction.kind === "user_input")
  );

  if (visibleInteractions.length === 0) return null;

  return (
    <section
      aria-labelledby="pending-interactions-heading"
      className={
        embedded
          ? "grid w-full gap-2 pl-10 md:pl-11"
          : "mx-auto grid w-full max-w-4xl gap-2 px-2 md:px-4"
      }
    >
      <h2 className="sr-only" id="pending-interactions-heading">
        Agent requests that need your response
      </h2>
      {visibleInteractions.map((interaction, index) => {
        const urlElicitation =
          interaction.kind === "mcp_elicitation"
            ? parseUrlElicitation(interaction.requestEnvelope)
            : null;
        const isRuntimeQuestion =
          interaction.source === "runtime" && interaction.kind === "user_input";
        return (
          <Card key={interaction.requestId}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                {interaction.kind === "approval" ||
                interaction.kind === "mcp_sampling"
                  ? "Approval required"
                  : "The agent needs your response"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm">{interaction.prompt}</p>
              {isRuntimeQuestion ? (
                <Textarea
                  aria-label="Response to the agent"
                  onChange={(event) =>
                    setContent((current) => ({
                      ...current,
                      [interaction.requestId]: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key === "Enter"
                    ) {
                      event.preventDefault();
                      void resolveRuntime(interaction);
                    }
                  }}
                  placeholder="Type your answer…"
                  ref={index === 0 ? firstControlRef : undefined}
                  value={content[interaction.requestId] ?? ""}
                />
              ) : null}
              {urlElicitation ? (
                <div className="space-y-2 text-sm">
                  <p>Target domain: {new URL(urlElicitation.url).hostname}</p>
                  <a
                    className="underline underline-offset-4"
                    href={urlElicitation.url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open secure authorization page
                  </a>
                </div>
              ) : interaction.kind === "mcp_elicitation" ? (
                <Textarea
                  aria-label="Response to the connected App as JSON"
                  onChange={(event) =>
                    setContent((current) => ({
                      ...current,
                      [interaction.requestId]: event.target.value,
                    }))
                  }
                  placeholder='{"answer":"value"}'
                  ref={index === 0 ? firstControlRef : undefined}
                  value={content[interaction.requestId] ?? "{}"}
                />
              ) : null}
              <div className="flex justify-end gap-2">
                {interaction.source === "runtime" ? (
                  interaction.kind === "approval" ? (
                    <>
                      <Button
                        disabled={busy !== null}
                        onClick={() => void resolveRuntime(interaction, false)}
                        size="sm"
                        variant="outline"
                      >
                        Deny
                      </Button>
                      <Button
                        autoFocus={index === 0}
                        disabled={busy !== null}
                        onClick={() => void resolveRuntime(interaction, true)}
                        size="sm"
                      >
                        Approve
                      </Button>
                    </>
                  ) : (
                    <Button
                      disabled={busy !== null}
                      onClick={() => void resolveRuntime(interaction)}
                      size="sm"
                    >
                      Send response
                    </Button>
                  )
                ) : (
                  <>
                    <Button
                      disabled={busy !== null}
                      onClick={() => void resolveMcp(interaction, "deny")}
                      size="sm"
                      variant="outline"
                    >
                      Deny
                    </Button>
                    <Button
                      autoFocus={index === 0 && !urlElicitation}
                      disabled={busy !== null}
                      onClick={() => void resolveMcp(interaction, "approve")}
                      size="sm"
                    >
                      {interaction.kind === "mcp_sampling"
                        ? "Allow"
                        : urlElicitation
                          ? "I completed it"
                          : "Submit"}
                    </Button>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
      {error ? (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
