import type { RunnerActorMetadata } from "../protocol/contracts.js";
import { ProtocolClient } from "./ProtocolClient.js";
import { createConfiguredRunnerTransport } from "./configuredTransport.js";

export const CLI_ACTOR_METADATA = {
  actorId: "kestrel-cli",
  actorType: "end_user",
  displayName: "Kestrel CLI",
} as const satisfies RunnerActorMetadata;

export function createConfiguredCliProtocolClient(
  env: NodeJS.ProcessEnv = process.env,
): ProtocolClient {
  return new ProtocolClient(createConfiguredRunnerTransport(env), {
    defaultMetadata: {
      actor: CLI_ACTOR_METADATA,
    },
    defaultExecutionDurability: "continue_on_disconnect",
  });
}
