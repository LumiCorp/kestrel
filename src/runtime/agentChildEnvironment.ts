const AGENT_CHILD_SECRET_NAMES = [
  "NGROK_AUTHTOKEN",
  "KESTREL_ONE_CREDENTIAL_BROKER_TOKEN",
  "KESTREL_WORKSPACE_SERVICE_TOKEN",
  "KESTREL_RUNNER_SERVICE_TOKEN",
  "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY",
  "FLY_API_TOKEN",
] as const;

export function agentChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of AGENT_CHILD_SECRET_NAMES) delete environment[name];
  return environment;
}
