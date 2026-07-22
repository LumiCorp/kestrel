import "server-only";

import { FlyMachinesClient } from "./providers/fly-machines";

export async function createFlyProviderClient(
  env: NodeJS.ProcessEnv = process.env,
) {
  const token = env.FLY_API_TOKEN?.trim();
  const organizationSlug = env.KESTREL_FLY_ORGANIZATION_SLUG?.trim();
  if (!(token && organizationSlug)) {
    throw new Error("Platform Fly provider connection is not configured.");
  }
  return new FlyMachinesClient({ token, organizationSlug });
}

export async function testPlatformFlyProviderConnection(
  env: NodeJS.ProcessEnv = process.env,
) {
  const provider = await createFlyProviderClient(env);
  await provider.testConnection();
}
