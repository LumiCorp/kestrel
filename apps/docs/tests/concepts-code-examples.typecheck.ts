/*
 * Contract fixture for the executable TypeScript shown in Concepts.
 * The docs build typechecks this file against the current public SDK source.
 * It is intentionally code-focused: editorial structure remains a human review concern.
 */
import {
  createAgent,
  type KestrelAgent,
  type KestrelRequestContext,
} from "../../../packages/sdk/src/index.js";

const context = {
  actor: {
    actorId: "user-123",
    actorType: "end_user",
    displayName: "Taylor Example",
    tenantId: "acme",
  },
  tenantId: "acme",
} satisfies KestrelRequestContext;

const agent = createAgent({
  id: "support-agent",
  profileId: "kestrel",
  target: {
    kind: "remote",
    baseUrl: "https://runner.example.test",
    authToken: "test-token",
  },
});

async function checkConceptExamples(client: KestrelAgent) {
  const terminal = await client.run(
    {
      sessionId: "customer-42",
      message: "Summarize the open support case.",
    },
    context,
  );

  const resumed = await client.resume(
    {
      sessionId: "customer-42",
      requestId: "interaction-123",
      message: "Approved for the production Environment.",
    },
    context,
  );

  const memory = await client.session("customer-42").memory.get(context);
  const updated = await client.session("customer-42").memory.update(
    {
      expectedRevision: memory.revision,
      patch: { findings: "Checkout totals require a currency code." },
    },
    context,
  );

  const events = client.subscribe(
    { sessionId: "customer-42", eventTypes: ["task.updated"] },
    context,
  );
  await events.ready;

  return { terminal, resumed, updated, events };
}

void agent;
void checkConceptExamples;
