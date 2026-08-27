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
  message?: string | undefined;
  decision?: "decline" | "approve_once" | "remember_approval" | undefined;
  reason?: string | undefined;
  recoveryOptionId?: string | undefined;
  presentation?: "control" | undefined;
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
    decision?: "decline" | "approve_once" | "remember_approval",
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
        ? decision === "remember_approval"
          ? "Remember approval"
          : decision === "approve_once"
            ? "Approve once"
            : "Decline"
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
        ...(interaction.kind === "approval" ? {} : { message }),
        ...(interaction.kind === "approval"
          ? { decision, presentation: "control" as const }
          : {}),
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

  async function retryRuntime(interaction: ThreadInteractionView) {
    setBusy(interaction.requestId);
    setError(null);
    try {
      const response = await fetch(
        `/api/threads/${threadId}/interactions/${encodeURIComponent(interaction.requestId)}/retry`,
        { method: "POST" },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Authorization retry was refused.");
      }
      await onResolved();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Authorization retry was refused.",
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
        const approvalDetails = readRuntimeApprovalDetails(interaction);
        const urlElicitation =
          interaction.kind === "mcp_elicitation"
            ? parseUrlElicitation(interaction.requestEnvelope)
            : null;
        const interactionTitle =
          structuredReview.kind === "invalid_review"
            ? "This request cannot be answered safely"
            : evaluationReview !== null
              ? "Result requires review"
              : interaction.kind === "approval" ||
                  interaction.kind === "mcp_sampling"
                ? (approvalDetails?.title ?? "Approval required")
                : "The agent needs your response";
        return (
          <Card
            className={
              approvalDetails !== null
                ? "w-full max-w-2xl justify-self-start overflow-hidden border-border/70 shadow-sm"
                : undefined
            }
            key={interaction.requestId}
          >
            <CardHeader
              className={
                approvalDetails !== null
                  ? "px-3 py-2.5"
                  : "pb-2"
              }
            >
              <div className="flex w-full items-center justify-between gap-3">
                <CardTitle className={approvalDetails !== null ? "text-sm" : "text-sm"}>
                  {interactionTitle}
                </CardTitle>
                {approvalDetails !== null && interaction.status !== "pending" ? (
                  <span
                    className={
                      interaction.status === "failed"
                        ? "text-destructive shrink-0 text-xs font-medium"
                        : "text-muted-foreground shrink-0 text-xs font-medium"
                    }
                    role="status"
                  >
                    {approvalStatusLabel(interaction)}
                  </span>
                ) : null}
              </div>
            </CardHeader>
            <CardContent
              className={
                approvalDetails !== null
                  ? "space-y-2 px-3 pb-3 pt-0"
                  : "space-y-3"
              }
            >
              {approvalDetails === null && interaction.status !== "pending" ? (
                <p
                  className={
                    interaction.status === "failed"
                      ? "text-destructive text-sm font-medium"
                      : "text-muted-foreground text-sm font-medium"
                  }
                  role="status"
                >
                  {interaction.status === "processing"
                    ? "Decision recorded"
                    : interaction.status === "resolved"
                      ? interaction.approvalOutcome?.authorizationState === "denied"
                        ? "Authorization declined"
                        : "Authorization accepted"
                      : interaction.approvalOutcome?.authorizationState === "expired"
                        ? "Authorization expired — operation not executed"
                      : interaction.approvalOutcome?.effectState === "not_started"
                        ? "Authorization failed — operation not executed"
                        : interaction.approvalOutcome?.effectState === "committed"
                          ? "Authorization failed after the operation committed"
                        : "Authorization failed — effect status unknown"}
                </p>
              ) : null}
              {interaction.approvalOutcome?.publicMessage ? (
                <p className="text-muted-foreground text-sm">
                  {interaction.approvalOutcome.publicMessage}
                </p>
              ) : null}
              {approvalDetails === null ? (
                <p className="text-sm">{interaction.prompt}</p>
              ) : null}
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
              {approvalDetails !== null ? (
                <section
                  aria-label="Approval request details"
                  className="space-y-2 text-sm"
                >
                  <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                    {approvalDetails.fields.map((field) => (
                      <div
                        className={
                          field.label === "Command"
                            ? "border-primary/30 border-l-2 pl-2.5 sm:col-span-2"
                            : "flex min-w-0 items-baseline gap-1.5"
                        }
                        key={field.label}
                      >
                        <dt className="text-muted-foreground shrink-0 text-[11px] font-medium">
                          {approvalFieldLabel(field.label)}
                        </dt>
                        <dd
                          className={
                            field.label === "Command"
                              ? "mt-0.5 whitespace-pre-wrap break-words font-mono text-[13px] leading-5"
                              : "truncate"
                          }
                        >
                          {approvalFieldValue(field.label, field.value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {interaction.status === "pending" ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <p className="text-muted-foreground">
                        {approvalReasonLabel(interaction, approvalDetails.policyReasonCode)}
                      </p>
                      {isRememberApprovalEligible(interaction) ? (
                        <p className="text-amber-700 dark:text-amber-300">
                          Allow for thread remembers this exact action.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              ) : null}
              {interaction.status === "pending" ? (
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
                        onClick={() => void resolveRuntime(interaction, "decline")}
                        size="sm"
                        variant="outline"
                      >
                        Don&apos;t allow
                      </Button>
                      {isCurrentHostedApprovalActionable(interaction) ? (
                        <Button
                          autoFocus={index === 0}
                          disabled={busy !== null}
                          onClick={() => void resolveRuntime(interaction, "approve_once")}
                          size="sm"
                          variant="outline"
                        >
                          Allow once
                        </Button>
                      ) : null}
                      {isRememberApprovalEligible(interaction) ? (
                        <Button
                          disabled={busy !== null}
                          onClick={() =>
                            void resolveRuntime(
                              interaction,
                              "remember_approval",
                            )
                          }
                          size="sm"
                        >
                          Allow for thread
                        </Button>
                      ) : null}
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
              ) : interaction.status === "failed" &&
                interaction.approvalOutcome?.retryEligible ? (
                <div className="flex justify-end gap-2">
                  <Button
                    disabled={busy !== null}
                    onClick={() => void retryRuntime(interaction)}
                    size="sm"
                  >
                    Try again
                  </Button>
                </div>
              ) : null}
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

function readRuntimeApprovalDetails(interaction: ThreadInteractionView): {
  toolName: string;
  title: string;
  summary: string;
  fields: Array<{ label: string; value: string }>;
  warnings: string[];
  policyExplanation: string;
  policyReasonCode: string | null;
} | null {
  if (interaction.source !== "runtime" || interaction.kind !== "approval") {
    return null;
  }
  const approval = readRecord(interaction.requestEnvelope.approval);
  const toolName = approval?.toolName;
  if (typeof toolName !== "string" || toolName.trim().length === 0) {
    return null;
  }
  const presentation = readRecord(approval?.presentation);
  const policy = readRecord(presentation?.policy);
  const fields = Array.isArray(presentation?.fields)
    ? presentation.fields.flatMap((value) => {
        const field = readRecord(value);
        return typeof field?.label === "string" &&
          typeof field.value === "string"
          ? [{ label: field.label, value: field.value }]
          : [];
      })
    : [];
  return {
    toolName,
    title:
      typeof presentation?.title === "string"
        ? presentation.title
        : "Approve tool operation",
    summary:
      typeof presentation?.summary === "string"
        ? presentation.summary
        : "Request details are hidden because this tool does not provide a safe approval preview.",
    fields,
    warnings: Array.isArray(presentation?.warnings)
      ? presentation.warnings.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    policyExplanation:
      typeof policy?.explanation === "string"
        ? policy.explanation
        : "This invocation requires approval.",
    policyReasonCode:
      typeof policy?.reasonCode === "string" ? policy.reasonCode : null,
  };
}

function approvalStatusLabel(interaction: ThreadInteractionView): string {
  if (interaction.status === "processing") return "Saving your choice...";
  if (interaction.status === "resolved") {
    return interaction.approvalOutcome?.authorizationState === "denied"
      ? "Not run"
      : "Allowed";
  }
  if (interaction.approvalOutcome?.authorizationState === "expired") {
    return "Expired";
  }
  if (interaction.approvalOutcome?.effectState === "committed") {
    return "Completed with an issue";
  }
  return "Not run";
}

function approvalFieldLabel(label: string): string {
  if (label === "Working directory") return "Folder";
  if (label === "Environment access") return "Environment";
  return label;
}

function approvalFieldValue(label: string, value: string): string {
  if (label === "Environment access" && (value === "[]" || value.length === 0)) {
    return "None";
  }
  return value;
}

function approvalReasonLabel(
  interaction: ThreadInteractionView,
  presentationReasonCode: string | null,
): string {
  const reasonCode = interaction.approvalPolicy?.reasonCode ?? presentationReasonCode;
  switch (reasonCode) {
    case "environment_policy":
      return "Your environment asks before this action runs.";
    case "project_restriction":
      return "This project asks before this action runs.";
    case "subject_restriction":
      return "Your access settings require approval for this action.";
    case "runtime_strict":
    case "tool_minimum":
      return "This action always needs your approval.";
    default:
      return "This action needs your approval before it can run.";
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isHostedV4Approval(interaction: ThreadInteractionView): boolean {
  return interaction.requestEnvelope.version ===
    "runner_hosted_tool_approval_interaction_v4";
}

function isStrictHostedApproval(interaction: ThreadInteractionView): boolean {
  return isHostedV4Approval(interaction);
}

function isRememberApprovalEligible(
  interaction: ThreadInteractionView,
): boolean {
  if (!isHostedV4Approval(interaction)) return false;
  const approval = readRecord(interaction.requestEnvelope.approval);
  const presentation = readRecord(approval?.presentation);
  const presentationPolicy = readRecord(presentation?.policy);
  return presentationPolicy?.rememberApprovalEligible === true &&
    interaction.approvalPolicy?.rememberApprovalEligible === true &&
    isCurrentHostedApprovalActionable(interaction);
}

function isCurrentHostedApprovalActionable(
  interaction: ThreadInteractionView,
): boolean {
  if (!isStrictHostedApproval(interaction)) return true;
  const policy = interaction.approvalPolicy;
  return policy !== undefined &&
    policy.environmentApprovalMode !== "deny" &&
    policy.projectApprovalMode !== "deny" &&
    policy.subjectApprovalMode !== "deny" &&
    policy.approvalResourceAvailable !== false;
}
