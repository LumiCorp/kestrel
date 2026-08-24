import type { EnvironmentExecutionTarget } from "@lumi/kestrel-environment-auth";

export const LOCAL_ENVIRONMENT_RUNTIME_IMAGE = "local-runner";
export const LOCAL_ENVIRONMENT_TICKET_APP_NAME = "kestrel-local-environment";

export function localEnvironmentExecutionTarget(
  workspaceId: string,
): EnvironmentExecutionTarget {
  return {
    provider: "fly",
    appName: LOCAL_ENVIRONMENT_TICKET_APP_NAME,
    machineId: workspaceId,
  };
}

export function isLocalEnvironmentExecutionTarget(input: {
  runtimeImage: string;
  workspaceId: string;
  appName: string;
  machineId: string;
}) {
  return (
    input.runtimeImage === LOCAL_ENVIRONMENT_RUNTIME_IMAGE &&
    input.appName === LOCAL_ENVIRONMENT_TICKET_APP_NAME &&
    input.machineId === input.workspaceId
  );
}
