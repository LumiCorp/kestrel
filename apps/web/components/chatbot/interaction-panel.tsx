"use client";

import { useEffect, useRef, useState } from "react";
import {
  runnerStructuredReviewOptionLabel,
  type RunnerStructuredReviewOptionId,
} from "@kestrel-agents/protocol";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { parseUrlElicitation } from "@/lib/mcp/interaction-protocol";
import type { ThreadInteractionView } from "@/lib/turns/client-contract";
import { readEvaluationReview } from "./evaluation-review";
import { readThreadStructuredReview } from "@/lib/turns/structured-review";

export type RuntimeInteractionResponse = {
  requestId: string;
  eventType: string;
  turnId: string;
  message: string;
  approved?: boolean | undefined;
  reason?: string | undefined;
  recoveryOptionId?: string | undefined;
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
    decision?: boolean,
    recoveryOptionId?: string
  ) {
    const answer = content[interaction.requestId]?.trim();
    const structuredReview = readThreadStructuredReview(interaction);
    const message =
      recoveryOptionId !== undefined && structuredReview.kind === "structured_review"
        ? runnerStructuredReviewOptionLabel(
            structuredReview.reason,
            recoveryOptionId as RunnerStructuredReviewOptionId
          )
        : interaction.kind === "approval"
        ? decision
          ? "Approved"
          : "Denied"
        : answer;
    if (!message) {
      setError("Enter a response before continuing.");
      return;
    }
    if (!interaction.turnId) {
      setError("The pending request is not attached to an active turn.");
      return;
    }
    setBusy(interaction.requestId);
    setError(null);
    try {
      await onRuntimeResponse({
        requestId: interaction.requestId,
        eventType: interaction.eventType,
        turnId: interaction.turnId,
        message,
        ...(interaction.kind === "approval" ? { approved: decision } : {}),
        ...(recoveryOptionId !== undefined ? { recoveryOptionId } : {}),
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

  async function cancelRuntimeWait(interaction: ThreadInteractionView) {
    if (!interaction.turnId) {
      setError("The waiting turn could not be identified.");
      return;
    }
    setBusy(interaction.requestId);
    setError(null);
    try {
      const response = await fetch(
        `/api/threads/${threadId}/turns/${interaction.turnId}/interrupt`,
        { method: "POST" }
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "The waiting turn could not be ended.");
      }
      await onResolved();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The waiting turn could not be ended."
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
      !(
        interaction.source === "runtime" &&
        interaction.kind === "user_input" &&
        readThreadStructuredReview(interaction).kind === "ordinary"
      )
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
        const structuredReview = readThreadStructuredReview(interaction);
        const evaluationReview = readEvaluationReview(interaction);
        const urlElicitation =
          interaction.kind === "mcp_elicitation"
            ? parseUrlElicitation(interaction.requestEnvelope)
            : null;
        return (
          <Card key={interaction.requestId}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                {structuredReview.kind === "invalid_review"
                  ? "This request cannot be answered safely"
                  : evaluationReview !== null
                  ? "Result requires review"
                  : interaction.kind === "approval" ||
                interaction.kind === "mcp_sampling"
                  ? "Approval required"
                  : "The agent needs your response"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm">{interaction.prompt}</p>
              {structuredReview.kind === "invalid_review" ? (
                <p className="text-muted-foreground text-sm" role="alert">
                  The saved interaction does not satisfy the structured-review
                  contract. End the waiting turn before continuing.
                </p>
              ) : null}
              {evaluationReview !== null ? (
                <details className="rounded-md border p-3 text-sm">
                  <summary className="cursor-pointer font-medium">
                    Technical details
                  </summary>
                  <div className="mt-3 space-y-3">
                    <div>
                      <p className="font-medium">Candidate</p>
                      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">
                        {evaluationReview.candidate}
                      </pre>
                    </div>
                    {evaluationReview.score !== undefined ? (
                      <p>
                        Score: {evaluationReview.score.toFixed(2)}
                        {evaluationReview.confidence !== undefined
                          ? ` · Confidence: ${evaluationReview.confidence.toFixed(2)}`
                          : ""}
                      </p>
                    ) : null}
                    {evaluationReview.rationale !== undefined ? (
                      <p>{evaluationReview.rationale}</p>
                    ) : null}
                    {evaluationReview.assertions.length > 0 ? (
                      <ul className="list-disc space-y-1 pl-5">
                        {evaluationReview.assertions.map((assertion) => (
                          <li key={assertion.assertionId}>
                            {assertion.passed ? "Passed" : "Failed"}: {assertion.assertionId}
                            {assertion.rationale !== undefined
                              ? ` — ${assertion.rationale}`
                              : ""}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {evaluationReview.evidenceReferences.length > 0 ? (
                      <p>
                        Evidence: {evaluationReview.evidenceReferences.join(", ")}
                      </p>
                    ) : null}
                  </div>
                </details>
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
                  structuredReview.kind === "structured_review" ? (
                    structuredReview.allowedOptionIds.map((optionId) => (
                      <Button
                        disabled={busy !== null}
                        key={optionId}
                        onClick={() =>
                          void resolveRuntime(interaction, undefined, optionId)
                        }
                        size="sm"
                        variant={optionId === "terminal.fail" ? "outline" : "default"}
                      >
                        {runnerStructuredReviewOptionLabel(
                          structuredReview.reason,
                          optionId
                        )}
                      </Button>
                    ))
                  ) : structuredReview.kind === "invalid_review" ? (
                    <Button
                      disabled={busy !== null}
                      onClick={() => void cancelRuntimeWait(interaction)}
                      size="sm"
                      variant="outline"
                    >
                      End waiting turn
                    </Button>
                  ) : interaction.kind === "approval" ? (
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
