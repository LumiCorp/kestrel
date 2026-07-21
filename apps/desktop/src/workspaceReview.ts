import type {
  WebRunnerAdapter,
  WebRunnerRequestContext,
} from "../../../src/web/index.js";
import type { DesktopWorkspaceReviewSnapshot } from "./contracts.js";
import { createDesktopError } from "./errors.js";

type ControlAdapter = Pick<WebRunnerAdapter, "sendControl">;
type Operation = "run" | "list" | "update" | "submit";

export async function runDesktopWorkspaceReview(input: {
  adapter: ControlAdapter;
  request: unknown;
  operation: Operation;
  context: WebRunnerRequestContext;
}): Promise<
  | DesktopWorkspaceReviewSnapshot
  | { snapshot: DesktopWorkspaceReviewSnapshot; runId: string }
> {
  const request = objectInput(input.request);
  const sessionId = text(request.sessionId, "sessionId");
  const threadId = text(request.threadId, "threadId");
  const base = { sessionId, threadId };
  if (
    input.operation === "update" &&
    request.action === "dismiss" &&
    !request.reason
  )
    throw error(
      "DESKTOP_WORKSPACE_REVIEW_INPUT_INVALID",
      "A dismissal reason is required.",
    );
  const command =
    input.operation === "list"
      ? { type: "workspace.review.list" as const, ...base }
      : input.operation === "run"
        ? {
            type: "workspace.review.run" as const,
            ...base,
            scope: scopeInput(request.scope),
            ...(request.mode === "detached_thread"
              ? { mode: "detached_thread" as const }
              : { mode: "current_thread" as const }),
            ...(request.reviewerProfileId
              ? {
                  reviewerProfileId: text(
                    request.reviewerProfileId,
                    "reviewerProfileId",
                  ),
                }
              : {}),
            ...(request.reviewerModel
              ? { reviewerModel: text(request.reviewerModel, "reviewerModel") }
              : {}),
          }
        : input.operation === "update"
          ? {
              type: "workspace.review.update" as const,
              ...base,
              candidateFingerprint: fingerprint(request.candidateFingerprint),
              reviewId: text(request.reviewId, "reviewId"),
              findingId: text(request.findingId, "findingId"),
              action: actionInput(request.action),
              ...(request.reason
                ? { reason: text(request.reason, "reason", 4096) }
                : {}),
            }
          : {
              type: "workspace.review.submit" as const,
              ...base,
              candidateFingerprint: fingerprint(request.candidateFingerprint),
              reviewId: text(request.reviewId, "reviewId"),
              findingIds: stringArray(request.findingIds),
              request: submitRequestInput(request.request),
            };
  const event = await input.adapter.sendControl(command, input.context);
  if (
    event.type !== "workspace.review" ||
    event.payload.sessionId !== sessionId ||
    event.payload.threadId !== threadId ||
    event.payload.operation !== input.operation
  )
    throw error(
      "DESKTOP_WORKSPACE_REVIEW_RESPONSE_INVALID",
      "Local Core returned invalid workspace review data.",
    );
  if (input.operation === "submit") {
    if (!event.payload.runId)
      throw error(
        "DESKTOP_WORKSPACE_REVIEW_RESPONSE_INVALID",
        "Local Core omitted the review follow-up run id.",
      );
    return { snapshot: event.payload.snapshot, runId: event.payload.runId };
  }
  return event.payload.snapshot;
}

function objectInput(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw error(
      "DESKTOP_WORKSPACE_REVIEW_INPUT_INVALID",
      "Review request must be an object.",
    );
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw error(
      "DESKTOP_WORKSPACE_REVIEW_INPUT_INVALID",
      `${label} is invalid.`,
    );
  return value.trim();
}
function fingerprint(value: unknown): string {
  const parsed = text(value, "candidateFingerprint", 256);
  if (!/^sha256:[a-f0-9]{64}$/u.test(parsed))
    throw error(
      "DESKTOP_WORKSPACE_REVIEW_INPUT_INVALID",
      "candidateFingerprint is invalid.",
    );
  return parsed;
}
function scopeInput(value: unknown) {
  const record = objectInput(value);
  if (
    record.kind === "unstaged" ||
    record.kind === "staged" ||
    record.kind === "uncommitted"
  )
    return { kind: record.kind } as const;
  if (record.kind === "branch")
    return {
      kind: "branch" as const,
      baseRef: text(record.baseRef, "baseRef"),
    };
  if (record.kind === "commit")
    return {
      kind: "commit" as const,
      commitSha: text(record.commitSha, "commitSha"),
    };
  if (record.kind === "pull_request") {
    const number =
      record.number === undefined ? undefined : Number(record.number);
    if (number !== undefined && (!Number.isInteger(number) || number <= 0))
      throw error(
        "DESKTOP_WORKSPACE_REVIEW_INPUT_INVALID",
        "pull request number is invalid.",
      );
    return {
      kind: "pull_request" as const,
      ...(number !== undefined ? { number } : {}),
    };
  }
  if (record.kind === "latest_run") return { kind: "latest_run" as const, ...(record.runId !== undefined ? { runId: text(record.runId, "runId") } : {}) };
  if (record.kind === "latest_turn") return { kind: "latest_turn" as const, ...(record.turnId !== undefined ? { turnId: text(record.turnId, "turnId") } : {}) };
  if (record.kind === "promotion") return { kind: "promotion" as const, promotionId: text(record.promotionId, "promotionId") };
  throw error("DESKTOP_WORKSPACE_REVIEW_INPUT_INVALID", "scope is invalid.");
}
function actionInput(
  value: unknown,
): "accept" | "dismiss" | "reopen" | "mark_fixed" {
  if (
    value === "accept" ||
    value === "dismiss" ||
    value === "reopen" ||
    value === "mark_fixed"
  )
    return value;
  throw error("DESKTOP_WORKSPACE_REVIEW_INPUT_INVALID", "action is invalid.");
}
function submitRequestInput(
  value: unknown,
): "address" | "more_evidence" | "verify" {
  if (value === "address" || value === "more_evidence" || value === "verify")
    return value;
  throw error("DESKTOP_WORKSPACE_REVIEW_INPUT_INVALID", "request is invalid.");
}
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100)
    throw error(
      "DESKTOP_WORKSPACE_REVIEW_INPUT_INVALID",
      "findingIds is invalid.",
    );
  return value.map((entry) => text(entry, "findingId"));
}
function error(code: string, message: string): Error {
  return createDesktopError({ code, message });
}
