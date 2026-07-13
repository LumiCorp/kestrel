export const WORKSPACE_IDLE_NOTIFICATION_VERSION =
  "workspace-idle-notification-v1" as const;

export async function notifyWorkspaceIdle(input: {
  controlPlaneUrl: string;
  authorizationToken: string;
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  machineId: string;
  lastActivityAt: Date;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      new URL("/api/runtime/environments/idle", input.controlPlaneUrl),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.authorizationToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: WORKSPACE_IDLE_NOTIFICATION_VERSION,
          organizationId: input.organizationId,
          environmentId: input.environmentId,
          workspaceId: input.workspaceId,
          machineId: input.machineId,
          lastActivityAt: input.lastActivityAt.toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
      }
    );
  } catch {
    return false;
  }
  if (response.status !== 202) return false;
  const payload = (await response.json().catch(() => null)) as {
    accepted?: unknown;
  } | null;
  return payload?.accepted === true;
}
