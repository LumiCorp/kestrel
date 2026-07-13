import type { UIMessage } from "ai";
import {
  findGithubIssueApprovalRequest,
  hasGithubApprovalDecision,
  respondToGithubApproval,
} from "../lib/integrations/github-approval-canary-contract";

export {};

type ThreadResponse = {
  id?: string;
  messages?: UIMessage[];
  error?: unknown;
};

const baseUrl = requiredUrl("KESTREL_ONE_CANARY_URL");
const cookie = required("KESTREL_ONE_CANARY_COOKIE");
const repository = requiredRepository("KESTREL_ONE_CANARY_REPOSITORY");
const threadId = required("KESTREL_ONE_CANARY_THREAD_ID");
const model = process.env.KESTREL_ONE_CANARY_MODEL?.trim();
const nonce = crypto.randomUUID();
const title = `Kestrel approval canary ${nonce}`;
const body = `Kestrel One approval-ledger canary ${nonce}. This request must be denied and must not create an issue.`;

const thread = await requestJson<ThreadResponse>(`/api/threads/${threadId}`);
assert(thread.id === threadId, "The designated canary Thread is unavailable.");

await submitTurn([
  {
    id: crypto.randomUUID(),
    role: "user",
    parts: [
      {
        type: "text",
        text: [
          "This is a Kestrel production approval-ledger canary.",
          `Request creation of a GitHub issue in ${repository}.`,
          `Use the exact title: ${title}`,
          `Use the exact body: ${body}`,
          "Use the GitHub issue creation tool now, perform no other action, and stop when user approval is required.",
        ].join("\n"),
      },
    ],
  },
]);

const pendingThread = await requestJson<ThreadResponse>(
  `/api/threads/${threadId}`
);
const approvalRequest = findGithubIssueApprovalRequest({
  messages: pendingThread.messages ?? [],
  repository,
  title,
  body,
});
assert(
  Boolean(approvalRequest),
  "The agent did not produce the exact GitHub issue approval request."
);

await submitTurn([
  respondToGithubApproval({
    request: approvalRequest!,
    approved: false,
    reason: `Kestrel approval-ledger canary denial ${nonce}`,
  }),
]);

const deniedThread = await requestJson<ThreadResponse>(
  `/api/threads/${threadId}`
);
assert(
  hasGithubApprovalDecision({
    messages: deniedThread.messages ?? [],
    approvalId: approvalRequest!.approvalId,
    approved: false,
  }),
  "The actor-bound GitHub denial was not persisted."
);

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      threadId,
      repository,
      nonce,
      approvalId: approvalRequest!.approvalId,
      proofs: [
        "github_issue_action_requested",
        "structured_approval_emitted",
        "approval_ledger_decision_accepted",
        "initiating_actor_denial_persisted",
        "github_mutation_not_authorized",
      ],
    },
    null,
    2
  ) + "\n"
);

async function submitTurn(messages: UIMessage[]) {
  const response = await fetch(new URL(`/api/threads/${threadId}`, baseUrl), {
    method: "POST",
    headers: requestHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      messages,
      ...(model ? { model } : {}),
    }),
    redirect: "manual",
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `POST /api/threads/${threadId} failed (${response.status}): ${responseText.slice(0, 1000)}`
    );
  }
}

async function requestJson<T>(pathname: string) {
  const response = await fetch(new URL(pathname, baseUrl), {
    headers: requestHeaders(),
    redirect: "manual",
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`GET ${pathname} returned non-JSON status ${response.status}.`);
  }
  if (!response.ok) {
    throw new Error(
      `GET ${pathname} failed (${response.status}): ${JSON.stringify(payload)}`
    );
  }
  return payload as T;
}

function requestHeaders(additional: Record<string, string> = {}) {
  return {
    accept: "application/json",
    cookie,
    origin: baseUrl.origin,
    ...additional,
  };
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredRepository(name: string) {
  const repositoryValue = required(name);
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repositoryValue)) {
    throw new Error(`${name} must be an owner/repository name.`);
  }
  return repositoryValue;
}

function requiredUrl(name: string) {
  const url = new URL(required(name));
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") {
    throw new Error(`${name} must use HTTPS outside local development.`);
  }
  return url;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
