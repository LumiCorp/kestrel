"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { parseUrlElicitation } from "@/lib/mcp/interaction-protocol";

type PendingInteraction = {
  id: string;
  kind: "sampling" | "elicitation";
  requestEnvelope: unknown;
};

export function McpInteractionPanel({
  threadId,
  active,
}: {
  threadId: string;
  active: boolean;
}) {
  const [interactions, setInteractions] = useState<PendingInteraction[]>([]);
  const [content, setContent] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(
          `/api/threads/${threadId}/mcp/interactions`,
          { signal: controller.signal }
        );
        if (!response.ok) throw new Error("App request status failed.");
        const payload = (await response.json()) as {
          interactions?: PendingInteraction[];
        };
        setInteractions(payload.interactions ?? []);
        setError(null);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(
            caught instanceof Error
              ? caught.message
              : "App request status failed."
          );
        }
      }
    };
    void refresh();
    const interval = window.setInterval(
      () => void refresh(),
      active ? 1000 : 5000
    );
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [active, threadId]);

  async function resolve(
    interaction: PendingInteraction,
    decision: "approve" | "deny"
  ) {
    setBusy(interaction.id);
    setError(null);
    try {
      let parsedContent: Record<string, unknown> | undefined;
      if (
        interaction.kind === "elicitation" &&
        decision === "approve" &&
        !parseUrlElicitation(interaction.requestEnvelope)
      ) {
        parsedContent = JSON.parse(content[interaction.id] || "{}") as Record<
          string,
          unknown
        >;
      }
      const response = await fetch(
        `/api/threads/${threadId}/mcp/interactions/${interaction.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision, content: parsedContent }),
        }
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(payload.error ?? "App request could not be resolved.");
      setInteractions((current) =>
        current.filter((candidate) => candidate.id !== interaction.id)
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "App request could not be resolved."
      );
    } finally {
      setBusy(null);
    }
  }

  if (interactions.length === 0 && !error) return null;

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-2 px-2 md:px-4">
      {interactions.map((interaction) => {
        const urlElicitation =
          interaction.kind === "elicitation"
            ? parseUrlElicitation(interaction.requestEnvelope)
            : null;
        return (
          <Card key={interaction.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                {interaction.kind === "sampling"
                  ? "An App wants to use the model"
                  : "An App needs information"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                {JSON.stringify(interaction.requestEnvelope, null, 2)}
              </pre>
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
              ) : interaction.kind === "elicitation" ? (
                <Textarea
                  aria-label="App response as JSON"
                  onChange={(event) =>
                    setContent((current) => ({
                      ...current,
                      [interaction.id]: event.target.value,
                    }))
                  }
                  placeholder='{"answer":"value"}'
                  value={content[interaction.id] ?? "{}"}
                />
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  disabled={busy !== null}
                  onClick={() => void resolve(interaction, "deny")}
                  size="sm"
                  variant="outline"
                >
                  Deny
                </Button>
                <Button
                  disabled={busy !== null}
                  onClick={() => void resolve(interaction, "approve")}
                  size="sm"
                >
                  {interaction.kind === "sampling"
                    ? "Allow sample"
                    : urlElicitation
                      ? "I completed it"
                      : "Submit"}
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}
