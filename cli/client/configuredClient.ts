import type { RunnerActorMetadata } from "../protocol/contracts.js";
import { ProtocolClient, type ProtocolClientOptions } from "./ProtocolClient.js";
import { createConfiguredRunnerTransport } from "./configuredTransport.js";

export const CLI_ACTOR_METADATA = {
  actorId: "kestrel-cli",
  actorType: "end_user",
  displayName: "Kestrel CLI",
} as const satisfies RunnerActorMetadata;

export function createConfiguredCliProtocolClient(
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<ProtocolClientOptions, "beforeSend"> = {},
): ProtocolClient {
  return new ProtocolClient(createConfiguredRunnerTransport(env), {
    defaultMetadata: {
      actor: CLI_ACTOR_METADATA,
    },
    defaultExecutionDurability: "continue_on_disconnect",
    beforeSend: options.beforeSend,
  });
}
