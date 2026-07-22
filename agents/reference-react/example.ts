import { randomUUID } from "node:crypto";

import {
  createDefaultToolGateway,
  createOpenRouterModelGatewayFromEnv,
  DEFAULT_BALANCED_TOOL_ALLOWLIST,
  Kestrel,
  createPostgresSessionStoreFromEnv,
  registerAgentReferenceRuntime,
} from "../../src/index.js";

async function main(): Promise<void> {
  const { store, pool } = createPostgresSessionStoreFromEnv();
  let finalized: unknown;

  const modelGateway = createOpenRouterModelGatewayFromEnv();
  const toolGateway = createDefaultToolGateway({
    allowlist: DEFAULT_BALANCED_TOOL_ALLOWLIST,
    context: {
      store,
      onFinalize: (payload) => {
        finalized = payload;
        return {
          ok: true,
          finalizedAt: new Date().toISOString(),
          payload,
        };
      },
    },
  });

  const kestrel = new Kestrel({
    store,
    modelGateway,
    toolGateway,
  });

  const { entryStepAgent } = registerAgentReferenceRuntime(kestrel);

  const result = await kestrel.run({
    id: randomUUID(),
    type: "INGRESS",
    sessionId: "react-reference-session",
    payload: {
      goal: "Find the current EUR to USD exchange rate and UTC time, then finalize.",
    },
    stepAgent: entryStepAgent,
  });

  console.log({ result, finalized });
  await pool.end();
}

void main();
