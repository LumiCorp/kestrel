import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runTuiScenario } from "../helpers/pty.js";
import { startFakeOpenRouterServer } from "../helpers/fake-open-router.js";

describe("TUI PTY journeys", () => {

const execFileAsync = promisify(execFile);

test("TUI workspace journey can be opened and exited back to chat deterministically", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    steps: [
      {
        waitFor: /ops-root · CHAT/i,
        actions: [{ typeText: "/workspace" }],
      },
      {
        waitFor: />\s*\/workspace/i,
        actions: [{ key: "enter" }],
      },
      {
        waitFor: /ops-root · WORKSPACE/i,
        actions: [{ key: "esc" }],
      },
      {
        waitFor: /ops-root · CHAT/i,
      },
    ],
  });

  assert.match(transcript, /ops-root · CHAT/i);
  assert.match(transcript, /ops-root · WORKSPACE/i);
  assert.match(transcript, /Back to Chat/i);
});

test("TUI MCP journey opens from slash command and returns to chat with Esc", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    steps: [
      { waitFor: /ops-root · CHAT/i, actions: [{ typeText: "/mcp" }] },
      { waitFor: />\s*\/mcp/i, actions: [{ key: "enter" }] },
      { waitFor: /ops-root · MCP/i, actions: [{ key: "esc" }] },
      { waitFor: /ops-root · CHAT/i },
    ],
  });

  assert.match(transcript, /ops-root · MCP/i);
  assert.match(transcript, /Back to Chat/i);
});

test("TUI Code journey opens from slash command and returns to chat with Esc", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    steps: [
      { waitFor: /ops-root · CHAT/i, actions: [{ typeText: "/code" }] },
      { waitFor: />\s*\/code/i, actions: [{ key: "enter" }] },
      { waitFor: /ops-root · CODE/i, actions: [{ key: "esc" }] },
      { waitFor: /ops-root · CHAT/i },
    ],
  });

  assert.match(transcript, /ops-root · CODE/i);
  assert.match(transcript, /Back to Chat/i);
});

test("TUI Delegation and Recovery journeys open from slash commands", async () => {
  const delegationTranscript = await runTuiScenario({
    sessionName: "ops-root",
    steps: [
      { waitFor: /ops-root · CHAT/i, actions: [{ typeText: "/child" }] },
      { waitFor: />\s*\/child/i, actions: [{ key: "enter" }] },
      { waitFor: /ops-root · DELEGATION/i },
    ],
  });
  const recoveryTranscript = await runTuiScenario({
    sessionName: "ops-root",
    steps: [
      { waitFor: /ops-root · CHAT/i, actions: [{ typeText: "/checkpoint" }] },
      { waitFor: />\s*\/checkpoint/i, actions: [{ key: "enter" }] },
      { waitFor: /ops-root · RECOVERY/i },
    ],
  });

  assert.match(delegationTranscript, /ops-root · DELEGATION/i);
  assert.match(recoveryTranscript, /ops-root · RECOVERY/i);
});

test("TUI scripted fresh-session startup lands in prompt-ready chat", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    freshSessionName: "ops-fresh-chat",
    steps: [
      {
        waitFor: /ops-fresh-chat · CHAT/i,
      },
    ],
  });

  assert.match(transcript, /ops-fresh-chat · CHAT/i);
});

test("TUI scripted chat submits non-command messages with Enter", async () => {
  const fakeOpenRouter = await startFakeOpenRouterServer();
  try {
    const transcript = await runTuiScenario({
      sessionName: "ops-root",
      freshSessionName: "ops-submit-message",
      env: { OPENROUTER_BASE_URL: fakeOpenRouter.url },
      abortPatterns: [{
        pattern: /RUN_ACCEPTANCE_UNCONFIRMED|mismatched session, thread, view, or message identity/i,
        reason: "TUI rejected a valid runtime-owned conversation route",
      }],
      steps: [
        {
          waitFor: /ops-submit-message · CHAT/i,
          actions: [{ typeText: "hello from scripted enter" }],
        },
        {
          waitFor: />\s*hello from scripted enter/i,
          actions: [{ key: "enter" }],
        },
        {
          waitFor: /RUNNING|Run in progress|Calling decision model/i,
        },
        {
          waitFor: /COMPLETED|FAILED|completed|failed/i,
          fromCursor: true,
        },
      ],
    });

    assert.match(transcript, />> hello from scripted enter/i);
    assert.match(transcript, /RUNNING|Run in progress|Calling decision model/i);
    assert.match(transcript, /COMPLETED|FAILED|completed|failed/i);
    assert.doesNotMatch(
      transcript,
      /RUN_ACCEPTANCE_UNCONFIRMED|mismatched session, thread, view, or message identity/i,
    );
  } finally {
    await fakeOpenRouter.close();
  }
});

for (const approval of [
  { label: "explicit", reply: "/mode build" },
  { label: "natural", reply: "Yes, switch to Build and continue." },
]) {
  test(`TUI ${approval.label} mode approval commits only the requested Git path`, async () => {
    const fakeOpenRouter = await startFakeOpenRouterServer();
    const repo = await createCommitJourneyRepository(fakeOpenRouter.url);
    try {
      const sessionName = `ops-commit-${approval.label}`;
      let transcript: string;
      try {
        transcript = await runTuiScenario({
          sessionName: "ops-root",
          freshSessionName: sessionName,
          cwd: repo,
          env: {
            KESTREL_CORE_CREDENTIAL_STORE: "environment",
            KESTREL_DISABLE_DOTENV: "0",
            OPENROUTER_BASE_URL: fakeOpenRouter.url,
          },
          abortPatterns: [{
            pattern: /RUN_ACCEPTANCE_UNCONFIRMED|RUNNER_RUNTIME_ERROR|mismatched session, thread, view, message, request, or run identity/i,
            reason: "TUI rejected the runtime-owned mode or terminal route",
          }],
          steps: [
            {
              waitFor: new RegExp(`${sessionName} · CHAT`, "i"),
              actions: [{ typeText: "fake-openrouter-commit-journey Commit intended.txt only and leave every unrelated path uncommitted." }],
            },
            {
              waitFor: />\s*fake-openrouter-commit-journey Commit intended\.txt only/i,
              actions: [{ key: "enter" }],
            },
            {
              waitFor: /requires Build\. Switch to Build/i,
              fromCursor: true,
              actions: [{ typeText: approval.reply }],
            },
            {
              waitFor: new RegExp(`>\\s*${approval.label === "explicit" ? "\\/mode build" : "Yes, switch to Build"}`, "i"),
              actions: [{ key: "enter" }],
            },
            {
              waitFor: /Committed intended\.txt and left unrelated files untracked\./i,
              fromCursor: true,
            },
          ],
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${detail}\nFake OpenRouter requests:\n${JSON.stringify(fakeOpenRouter.requests, null, 2)}`);
      }

      const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo });
      const { stdout: parent } = await execFileAsync("git", ["rev-parse", "HEAD^"], { cwd: repo });
      const { stdout: committedNames } = await execFileAsync(
        "git",
        ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
        { cwd: repo },
      );
      const { stdout: status } = await execFileAsync("git", ["status", "--short"], { cwd: repo });
      assert.notEqual(head.trim(), parent.trim());
      assert.deepEqual(committedNames.trim().split("\n"), ["intended.txt"]);
      assert.match(status, /\?\? node_modules\//u);
      assert.doesNotMatch(committedNames, /node_modules/u);
      assert.match(await readFile(path.join(repo, "intended.txt"), "utf8"), /requested change/u);
      assert.doesNotMatch(
        transcript,
        /RUN_ACCEPTANCE_UNCONFIRMED|RUNNER_RUNTIME_ERROR/u,
      );
    } finally {
      await fakeOpenRouter.close();
      await rm(repo, { recursive: true, force: true });
    }
  });
}

test("TUI workspace journey supports deterministic arrow-key navigation", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    steps: [
      { waitFor: /ops-root · CHAT/i, actions: [{ typeText: "/workspace" }] },
      { waitFor: />\s*\/workspace/i, actions: [{ key: "enter" }] },
      { waitFor: />\s*Start task in selected workspace/i, actions: [{ key: "down" }] },
      { waitFor: />\s*Switch to detached/i, actions: [{ key: "down" }] },
      { waitFor: />\s*Open History Home/i, actions: [{ key: "down" }] },
      { waitFor: />\s*Back to Chat/i, actions: [{ key: "enter" }] },
      { waitFor: /ops-root · CHAT/i },
    ],
  });

  assert.match(transcript, />\s*Switch to detached/i);
  assert.match(transcript, />\s*Open History Home/i);
  assert.match(transcript, />\s*Back to Chat/i);
  assert.match(transcript, /ops-root · CHAT/i);
});

async function createCommitJourneyRepository(openRouterUrl: string): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "kestrel-tui-commit-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "kestrel-test@example.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Kestrel Test"], { cwd: repo });
  await writeFile(path.join(repo, "intended.txt"), "baseline\n", "utf8");
  await writeFile(
    path.join(repo, ".env"),
    `OPENROUTER_API_KEY=ops-test-openrouter\nOPENROUTER_BASE_URL=${openRouterUrl}\n`,
    "utf8",
  );
  await execFileAsync("git", ["add", "--", ".env", "intended.txt"], { cwd: repo });
  await execFileAsync("git", ["commit", "--quiet", "-m", "Initial fixture"], { cwd: repo });
  await writeFile(path.join(repo, "intended.txt"), "baseline\nrequested change\n", "utf8");
  await mkdir(path.join(repo, "node_modules", "decoy"), { recursive: true });
  await writeFile(path.join(repo, "node_modules", "decoy", "package.json"), "{}\n", "utf8");
  return repo;
}
});
