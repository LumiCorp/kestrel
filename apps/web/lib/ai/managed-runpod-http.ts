import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { RunPodControlPlaneError } from "./runpod-control-plane";

const CONFLICT_MESSAGES = [
  "entitlement is required",
  "not enabled",
  "quota is exhausted",
  "qualification is required",
  "can be qualified",
  "can be retried",
  "may delete it",
  "already exists for this profile",
] as const;

export function managedRunPodErrorResponse(error: unknown) {
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        code: "MANAGED_RUNPOD_INPUT_INVALID",
        error: "Managed RunPod request is invalid.",
      },
      { status: 400 }
    );
  }
  if (error instanceof RunPodControlPlaneError) {
    return NextResponse.json(
      { code: error.code, error: error.message },
      { status: error.status }
    );
  }
  const message =
    error instanceof Error ? error.message : "Managed RunPod request failed.";
  const status =
    message === "Unauthorized"
      ? 401
      : message === "Forbidden"
        ? 403
        : CONFLICT_MESSAGES.some((part) => message.includes(part))
          ? 409
          : message.includes("not found")
            ? 404
            : 500;
  return NextResponse.json(
    {
      code:
        status === 500
          ? "MANAGED_RUNPOD_REQUEST_FAILED"
          : "MANAGED_RUNPOD_REQUEST_REJECTED",
      error: status === 500 ? "Managed RunPod request failed." : message,
    },
    { status }
  );
}
