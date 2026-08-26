import type { HostedToolApprovalDecision } from "@kestrel-agents/protocol";
import { chromium, type Browser } from "@playwright/test";
import type { UIMessage } from "ai";
import {
  findSubmittedToolApproval,
  type SubmittedToolApproval,
} from "../lib/chat/tool-approval-response";
import {
  assertDurableApprovalTerminal,
  findGithubDurableApprovalRequest,
  findGithubIssueApprovalRequest,
  hasGithubApprovalDecision,
  respondToGithubApproval,
} from "../lib/integrations/github-approval-canary-contract";
import type {
  ThreadInteractionView,
  ThreadTurnView,
} from "../lib/turns/client-contract";

export {};

type ThreadResponse = {
  id?: string;
  projectId?: string | null;
  messages?: UIMessage[];
  interactions?: ThreadInteractionView[];
  turns?: ThreadTurnView[];
  error?: unknown;
};

const baseUrl = requiredUrl("KESTREL_ONE_CANARY_URL");
const cookie = required("KESTREL_ONE_CANARY_COOKIE");
const repository = requiredRepository("KESTREL_ONE_CANARY_REPOSITORY");
const threadId = required("KESTREL_ONE_CANARY_THREAD_ID");
const model = process.env.KESTREL_ONE_CANARY_MODEL?.trim();
const protocol = requiredChoice("KESTREL_ONE_CANARY_APPROVAL_PROTOCOL", [
  "legacy_v1",
  "durable_v3",
] as const);
const expectation =
  protocol === "durable_v3"
    ? requiredChoice("KESTREL_ONE_CANARY_EXPECT", [
        "approval",
        "remembered_auto",
      ] as const)
    : "approval";
const decision =
  protocol === "durable_v3" && expectation === "approval"
    ? requiredChoice("KESTREL_ONE_CANARY_DECISION", [
        "decline",
        "approve_once",
        "remember_approval",
      ] as const)
    : expectation === "remembered_auto"
      ? "remember_approval"
      : "decline";
const nonce = crypto.randomUUID();
const title = `Kestrel approval canary ${nonce}`;
const body =
  protocol === "durable_v3" && decision !== "decline"
    ? `Kestrel hosted approval canary ${nonce}. This issue is intentional production proof.`
    : `Kestrel hosted approval canary ${nonce}. This request must be denied and must not create an issue.`;

if (
  decision !== "decline" &&
  process.env.KESTREL_ONE_CANARY_CONFIRM_GITHUB_MUTATION !==
    "CREATE_ONE_CANARY_ISSUE"
) {
  throw new Error(
    "KESTREL_ONE_CANARY_CONFIRM_GITHUB_MUTATION must equal CREATE_ONE_CANARY_ISSUE for an approving canary.",
  );
}

const thread = await requestJson<ThreadResponse>(`/api/threads/${threadId}`);
assert(thread.id === threadId, "The designated canary Thread is unavailable.");

if (protocol === "legacy_v1") {
  await submitTurn({
    message: githubIssueRequestMessage({ repository, title, body }),
  });
  await runLegacyDenial();
} else {
  if (expectation === "remembered_auto") {
    await runRememberedAutoBrowser();
  } else {
    await runDurableBrowserDecision(decision);
  }
}

async function runLegacyDenial() {
  const pendingThread = await waitForThread((snapshot) =>
    Boolean(
      findGithubIssueApprovalRequest({
        messages: snapshot.messages ?? [],
        repository,
        title,
        body,
      }),
    ),
  );
  const approvalRequest = findGithubIssueApprovalRequest({
    messages: pendingThread.messages ?? [],
    repository,
    title,
    body,
  });
  assert(
    approvalRequest,
    "The agent did not produce the exact legacy approval request.",
  );
  const approvalResponse = findSubmittedToolApproval([
    respondToGithubApproval({
      request: approvalRequest,
      approved: false,
      reason: `Kestrel legacy approval drain canary denial ${nonce}`,
    }),
  ]);
  assert(
    approvalResponse,
    "The legacy approval response could not be encoded.",
  );
  await submitTurn({ approvalResponse });
  const deniedThread = await waitForThread((snapshot) =>
    hasGithubApprovalDecision({
      messages: snapshot.messages ?? [],
      approvalId: approvalRequest.approvalId,
      approved: false,
    }),
  );
  assert(
    hasGithubApprovalDecision({
      messages: deniedThread.messages ?? [],
      approvalId: approvalRequest.approvalId,
      approved: false,
    }),
    "The actor-bound legacy denial was not persisted.",
  );
  writeResult({
    protocol,
    decision: "decline",
    requestId: approvalRequest.approvalId,
    preparedInvocationId: null,
    identityRevision: null,
    authorityRevision: null,
    effectState: "not_started",
  });
}

async function runDurableBrowserDecision(
  selectedDecision: HostedToolApprovalDecision,
) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await authenticatedThreadPage(browser);
    const composer = page.getByRole("textbox", { name: "Send a message..." });
    await composer.fill(messageText({ repository, title, body }));
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await page
      .getByText("Create a GitHub issue", { exact: true })
      .last()
      .waitFor();
    for (const label of ["Decline", "Approve Once", "Remember Approval"]) {
      await page
        .getByRole("button", { name: label, exact: true })
        .last()
        .waitFor();
    }
    const pendingThread = await waitForThread((snapshot) =>
      Boolean(
        findGithubDurableApprovalRequest({
          interactions: snapshot.interactions ?? [],
          repository,
          title,
          body,
        }),
      ),
    );
    const approvalRequest = findGithubDurableApprovalRequest({
      interactions: pendingThread.interactions ?? [],
      repository,
      title,
      body,
    });
    assert(
      approvalRequest,
      "The agent did not produce the exact durable V3 approval request.",
    );
    const buttonLabel =
      selectedDecision === "decline"
        ? "Decline"
        : selectedDecision === "approve_once"
          ? "Approve Once"
          : "Remember Approval";
    await page
      .getByRole("button", {
        name: buttonLabel,
        exact: true,
      })
      .last()
      .click();
    const terminalThread = await waitForThread((snapshot) =>
      assertDurableApprovalTerminal({
        interactions: snapshot.interactions ?? [],
        request: approvalRequest,
        decision: selectedDecision,
      }),
    );
    assert(
      assertDurableApprovalTerminal({
        interactions: terminalThread.interactions ?? [],
        request: approvalRequest,
        decision: selectedDecision,
      }),
      "The exact durable approval did not reach its required terminal effect state.",
    );
    const terminal = terminalThread.interactions?.find(
      (interaction) => interaction.id === approvalRequest.interactionId,
    );
    const { readHostedApprovalProof } =
      await import("../lib/apps/hosted-approval-proof");
    const proof = await readHostedApprovalProof({
      threadId,
      interactionId: approvalRequest.interactionId,
    });
    assert(
      proof.ok,
      `The server-side approval proof did not join exactly: ${proof.mismatches.join(", ")}`,
    );
    writeResult({
      protocol,
      decision: selectedDecision,
      interactionId: approvalRequest.interactionId,
      requestId: approvalRequest.requestId,
      preparedInvocationId: approvalRequest.preparedInvocationId,
      identityRevision:
        approvalRequest.stableToolIdentity.descriptorContractRevision,
      authorityRevision:
        approvalRequest.stableToolIdentity.approvalAuthorityRevision,
      actorId: approvalRequest.requestingActor.actorId,
      tenantId: approvalRequest.requestingActor.tenantId,
      effectState: terminal?.approvalOutcome?.effectState ?? null,
      browserDecision: true,
      serverProof: proof,
    });
  } finally {
    await browser.close();
  }
}

async function runRememberedAutoBrowser() {
  const before = await requestJson<ThreadResponse>(`/api/threads/${threadId}`);
  const priorTurnIds = new Set((before.turns ?? []).map((turn) => turn.id));
  const priorInteractionIds = new Set(
    (before.interactions ?? []).map((interaction) => interaction.id),
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await authenticatedThreadPage(browser);
    await page
      .getByRole("textbox", { name: "Send a message..." })
      .fill(messageText({ repository, title, body }));
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const completed = await waitForThread((snapshot) =>
      (snapshot.turns ?? []).some(
        (turn) => !priorTurnIds.has(turn.id) && turn.status === "completed",
      ),
    );
    const newTurn = (completed.turns ?? []).find(
      (turn) => !priorTurnIds.has(turn.id) && turn.status === "completed",
    );
    assert(
      newTurn?.status === "completed",
      "The remembered call did not complete.",
    );
    const newApproval = (completed.interactions ?? []).find((interaction) => {
      if (
        priorInteractionIds.has(interaction.id) ||
        interaction.kind !== "approval"
      ) {
        return false;
      }
      const approval = asRecord(interaction.requestEnvelope.approval);
      return approval?.toolName === "kestrel_one.github_issue_create";
    });
    assert(
      !newApproval,
      "The remembered call emitted another approval interaction.",
    );
    await waitForGithubIssue();
    writeResult({
      protocol,
      expectation,
      decision: null,
      turnId: newTurn.id,
      browserDecision: false,
      rememberedEvidence: "automatic_without_card",
      effectState: "committed",
      providerProof: "github_issue_observed",
    });
  } finally {
    await browser.close();
  }
}

function githubIssueRequestMessage(input: {
  repository: string;
  title: string;
  body: string;
}): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [
      {
        type: "text",
        text: messageText(input),
      },
    ],
  };
}

function messageText(input: {
  repository: string;
  title: string;
  body: string;
}) {
  return [
    "This is a Kestrel production hosted-approval canary.",
    `Request creation of a GitHub issue in ${input.repository}.`,
    `Use the exact title: ${input.title}`,
    `Use the exact body: ${input.body}`,
    "Use the GitHub issue creation tool now, perform no other action, and stop when user approval is required.",
  ].join("\n");
}

async function authenticatedThreadPage(browser: Browser) {
  const context = await browser.newContext();
  await context.addCookies(
    cookie.split(";").map((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0)
        throw new Error("KESTREL_ONE_CANARY_COOKIE is invalid.");
      return {
        name: entry.slice(0, separator).trim(),
        value: entry.slice(separator + 1).trim(),
        url: baseUrl.origin,
      };
    }),
  );
  const page = await context.newPage();
  await page.goto(new URL(`/threads/${threadId}`, baseUrl).toString());
  if (new URL(page.url()).pathname !== `/threads/${threadId}`) {
    throw new Error(
      "The browser canary was not authenticated to the designated Thread.",
    );
  }
  return page;
}

async function waitForGithubIssue(timeoutMs = 180_000) {
  const [owner, name] = repository.split("/");
  const token = process.env.KESTREL_ONE_CANARY_GITHUB_READ_TOKEN?.trim();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/issues?state=all&per_page=100`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "kestrel-hosted-approval-canary",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub canary read failed (${response.status}).`);
    }
    const issues = (await response.json()) as Array<Record<string, unknown>>;
    if (issues.some((issue) => issue.title === title && issue.body === body))
      return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("The exact remembered-call GitHub effect was not observed.");
}

async function waitForThread(
  predicate: (thread: ThreadResponse) => boolean,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest: ThreadResponse | undefined;
  while (Date.now() < deadline) {
    latest = await requestJson<ThreadResponse>(`/api/threads/${threadId}`);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `Timed out waiting for hosted approval evidence. Latest turn states: ${JSON.stringify(
      latest?.turns?.map(({ id, status, failureCode }) => ({
        id,
        status,
        failureCode,
      })) ?? [],
    )}`,
  );
}

function writeResult(evidence: Record<string, unknown>) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        threadId,
        repository,
        nonce,
        ...evidence,
      },
      null,
      2,
    )}\n`,
  );
}

async function submitTurn(
  action:
    | { message: UIMessage; approvalResponse?: never }
    | { message?: never; approvalResponse: SubmittedToolApproval },
) {
  const response = await fetch(new URL(`/api/threads/${threadId}`, baseUrl), {
    method: "POST",
    headers: requestHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      ...action,
      ...(model ? { model } : {}),
    }),
    redirect: "manual",
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `POST /api/threads/${threadId} failed (${response.status}): ${responseText.slice(0, 1000)}`,
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
    throw new Error(
      `GET ${pathname} returned non-JSON status ${response.status}.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `GET ${pathname} failed (${response.status}): ${JSON.stringify(payload)}`,
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

function requiredChoice<const T extends readonly string[]>(
  name: string,
  choices: T,
) {
  const value = required(name);
  if (!choices.includes(value)) {
    throw new Error(`${name} must be one of: ${choices.join(", ")}.`);
  }
  return value as T[number];
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
