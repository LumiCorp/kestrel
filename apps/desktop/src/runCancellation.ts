import type { WebRunnerAdapter, WebRunnerRequestContext } from "../../../src/web/index.js";
import type {
  DesktopRunCancellationResult,
  DesktopRunCancelRequest,
} from "./contracts.js";

type ControlAdapter = Pick<WebRunnerAdapter, "sendControl">;

export async function cancelDesktopRun(input: {
  adapter: ControlAdapter;
  request: DesktopRunCancelRequest;
  context: WebRunnerRequestContext;
}): Promise<DesktopRunCancellationResult> {
  try {
    const event = await input.adapter.sendControl(
      { type: "run.cancel", ...input.request },
      input.context,
    );
    return { status: "cancelled", event };
  } catch (error) {
    if (runnerErrorCode(error) === "RUN_CANCEL_NOT_FOUND") {
      const activeTarget = runnerActiveTarget(error);
      if (
        activeTarget.activeRunId !== undefined
        || activeTarget.activeCommandId !== undefined
      ) {
        return { status: "run_changed", ...activeTarget };
      }
      return { status: "already_stopped" };
    }
    throw error;
  }
}

function runnerActiveTarget(error: unknown): {
  activeRunId?: string | undefined;
  activeCommandId?: string | undefined;
} {
  if (typeof error !== "object" || error === null || !("details" in error)) {
    return {};
  }
  const details = error.details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return {};
  }
  const activeRunId = nonEmptyString(
    (details as Record<string, unknown>).activeRunId,
  );
  const activeCommandId = nonEmptyString(
    (details as Record<string, unknown>).activeCommandId,
  );
  return {
    ...(activeRunId !== undefined ? { activeRunId } : {}),
    ...(activeCommandId !== undefined ? { activeCommandId } : {}),
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function runnerErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
