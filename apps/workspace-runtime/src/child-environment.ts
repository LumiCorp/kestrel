const WORKSPACE_CHILD_SECRET_NAMES = [
  "NGROK_AUTHTOKEN",
  "KESTREL_ONE_CREDENTIAL_BROKER_TOKEN",
  "KESTREL_WORKSPACE_SERVICE_TOKEN",
  "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY",
  "FLY_API_TOKEN",
] as const;

export function workspaceChildEnvironment(
  source: NodeJS.ProcessEnv = process.env
) {
  const environment = { ...source };
  for (const name of WORKSPACE_CHILD_SECRET_NAMES) delete environment[name];
  return environment;
}

export function workspaceRunnerEnvironment(input: {
  source?: NodeJS.ProcessEnv | undefined;
  home: string;
  storeDir: string;
  runtimeUrl: string;
  serviceToken: string;
  workspaceServiceToken: string;
}) {
  return {
    ...workspaceChildEnvironment(input.source),
    HOME: input.home,
    KESTREL_HOME: input.home,
    KESTREL_RUNNER_STORE_DIR: input.storeDir,
    KESTREL_WORKSPACE_SERVICE_TOKEN: input.workspaceServiceToken,
    KESTREL_WORKSPACE_RUNTIME_URL: input.runtimeUrl,
    KESTREL_RUNNER_SERVICE_HOST: "127.0.0.1",
    KESTREL_RUNNER_SERVICE_PORT: "43105",
    KESTREL_RUNNER_SERVICE_TOKEN: input.serviceToken,
  };
}
