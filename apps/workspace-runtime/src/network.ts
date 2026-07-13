export function workspaceListenHost(input: {
  flyPrivateIp?: string | undefined;
  configuredHost?: string | undefined;
}) {
  const configuredHost = input.configuredHost?.trim();
  if (configuredHost) return configuredHost;
  return input.flyPrivateIp?.trim() ? "::" : "0.0.0.0";
}
