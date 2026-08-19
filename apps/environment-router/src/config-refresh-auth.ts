import {
  getFlyEnvironmentExecutionTarget,
  getGatewayEnvironmentExecutionTarget,
  verifyEnvironmentExecutionTicket,
  verifyEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";

export function authorizeConfigRefreshToken(input: {
  token: string;
  publicKey: string;
  environmentId: string;
  expectedAppName?: string | undefined;
  expectedGatewayId?: string | undefined;
  now?: number | undefined;
}) {
  try {
    const ticket = verifyEnvironmentExecutionTicket({
      token: input.token,
      publicKey: input.publicKey,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    const target = getFlyEnvironmentExecutionTarget(ticket);
    const gateway = getGatewayEnvironmentExecutionTarget(ticket);
    if (
      ticket.environmentId === input.environmentId &&
      ((input.expectedGatewayId !== undefined &&
        gateway?.gatewayId === input.expectedGatewayId) ||
        (input.expectedAppName !== undefined &&
          target?.appName === input.expectedAppName)) &&
      ticket.capabilities.includes("gateway.config.refresh")
    ) return;
  } catch {}
  const credential = verifyEnvironmentToolCredential({
    token: input.token,
    publicKey: input.publicKey,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (
    credential.environmentId !== input.environmentId ||
    credential.providerKey !== "kestrel-control-plane" ||
    credential.resourceId !== input.environmentId ||
    credential.capability !== "gateway.config.refresh" ||
    credential.operation !== "refresh" ||
    credential.operationBinding !== null
  ) throw new Error("scope denied");
}
