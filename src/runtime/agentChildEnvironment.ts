const AGENT_CHILD_SECRET_NAMES = [
  "KESTREL_ONE_CREDENTIAL_BROKER_TOKEN",
  "KESTREL_WORKSPACE_SERVICE_TOKEN",
  "KESTREL_RUNNER_SERVICE_TOKEN",
  "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY",
  "KESTREL_DEV_SHELL_STORE_DRIVER",
  "KESTREL_DEV_SHELL_STORE_DATABASE_URL",
  "KESTREL_DEV_SHELL_STORE_BINDING_REVISION",
  "FLY_API_TOKEN",
] as const;

export function agentChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of AGENT_CHILD_SECRET_NAMES) delete environment[name];
  return environment;
}
