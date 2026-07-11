import { test, expect, type Page } from "@playwright/test";

import { OPS_FIXTURE_IDS } from "../helpers/fixtures.js";

test("ops run list surfaces dominant failure and child blockers", async ({ page }) => {
  await page.goto("/ops");

  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await page.getByPlaceholder("Search runs, sessions, errors, or steps").fill(OPS_FIXTURE_IDS.root.runId);
  const row = page.getByRole("row").filter({ hasText: OPS_FIXTURE_IDS.root.runId });
  await expect(row).toBeVisible();
  await expect(row).toContainText("WAITING");
  await expect(row).toContainText(OPS_FIXTURE_IDS.root.sessionId);
  await expect(row).toContainText("Ops root runtime bundle");
  await expect(row).toContainText("approval_wait");
  await expect(row).toContainText("5");
  await expect(row.getByRole("button", { name: "Open row actions" })).toBeVisible();
});

test("ops run detail renders blocking, approval, and delegation details", async ({ page }) => {
  await openRunDetail(page, OPS_FIXTURE_IDS.approvalChild.runId);

  await expect(page.getByRole("heading", { name: "Blocking" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Approval chain" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Delegations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Grouped transitions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Assembly", exact: true })).toBeVisible();
  await expect(page.getByTestId("ops-blocking-detail")).toContainText("Approve child thread before continuing.");
  await expect(page.getByText(`request:${OPS_FIXTURE_IDS.approvalChild.requestId}`).first()).toBeVisible();
  await expect(page.getByText(`delegation:${OPS_FIXTURE_IDS.root.delegationId}`).first()).toBeVisible();
  await expect(page.getByText("provider:openrouter/google/gemini-3.1-flash-lite-preview").first()).toBeVisible();
  await expect(page.getByText("variant:reference-react:approval")).toBeVisible();
  await expect(page.getByText("compatibility:downgraded via policy - structured_output_unavailable")).toBeVisible();
  await expect(page.getByText("downgrade reason:approval_prompt_variant_unavailable")).toBeVisible();
});

test("ops run detail surfaces multi-child supervision state and superseded markers", async ({ page }) => {
  await openRunDetail(page, OPS_FIXTURE_IDS.root.runId);
  const supervisionSection = page.locator("article").filter({
    has: page.getByRole("heading", { name: "Child supervision" }),
  });

  await expect(page.getByRole("heading", { name: "Child supervision" })).toBeVisible();
  await expect(page.getByTestId("ops-child-summary-total")).toContainText("children:3");
  await expect(page.getByText(/next action:/)).toBeVisible();
  await expect(page.getByText(/fan-in checkpoint:\s*not recorded/)).toBeVisible();
  await expect(page.getByText(/superseded markers:.*ops-superseded-child-thread/i)).toBeVisible();
  await expect(supervisionSection.getByText(/ops-completed-child-thread COMPLETED .* delegation:COMPLETED .*Collected supporting evidence\./i)).toBeVisible();
  await expect(supervisionSection.getByText(/ops-superseded-child-thread (COMPLETED|CANCELLED) .* delegation:CANCELLED .* superseded/i)).toBeVisible();
});

test("ops run detail routes supervision actions through the parent thread", async ({ page }) => {
  let controlRequest:
    | {
        action?: string;
        threadId?: string;
        delegationId?: string;
      }
    | undefined;

  await page.route("**/api/kchat/control", async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      threadId?: string;
      delegationId?: string;
    };
    controlRequest = body;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        event: {
          id: "evt-operator-controlled",
          type: "operator.controlled",
          ts: new Date().toISOString(),
          payload: {
            threadId: body.threadId,
          },
        },
      }),
    });
  });

  await openRunDetail(page, OPS_FIXTURE_IDS.root.runId);
  await expect(page.getByRole("button", { name: "Supersede child" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Supersede child" }).first().click();

  expect(controlRequest).toBeDefined();
  expect(controlRequest?.action).toBe("supersede_child_thread");
  expect(controlRequest?.threadId).toBe(OPS_FIXTURE_IDS.root.threadId);
  expect(controlRequest?.delegationId).toBe(OPS_FIXTURE_IDS.root.delegationId);
});

test("ops run detail renders compaction lineage and authoritative summary", async ({ page }) => {
  await openRunDetail(page, OPS_FIXTURE_IDS.compaction.runId);

  await expect(page.getByRole("heading", { name: "Compaction", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Adaptation & evidence" })).toBeVisible();
  await expect(page.getByText(`authoritative:${OPS_FIXTURE_IDS.compaction.artifactId}`)).toBeVisible();
  await expect(page.getByText("Compacted summary for operator inspection.")).toBeVisible();
  await expect(page.getByTestId("ops-adaptation-summary")).toContainText("auto_applied");
  await expect(page.getByTestId("ops-evidence-recovery-summary")).toHaveText(/evidence:(attempts=\d+|not recorded)/);
  await expect(page.getByText(/issues:(source_coverage_gap|not recorded)/)).toBeVisible();
});

test("ops session detail retains run linkage for seeded sessions", async ({ page }) => {
  await page.goto(`/ops/sessions/${OPS_FIXTURE_IDS.root.sessionId}`);

  await expect(page.getByRole("heading", { name: "Recent runs" })).toBeVisible();
  await expect(page.getByRole("link", { name: OPS_FIXTURE_IDS.root.runId })).toBeVisible();
  await expect(page.getByText("provider:openrouter/google/gemini-3.1-flash-lite-preview")).toBeVisible();
  await expect(page.getByText("variant:reference-react:root")).toBeVisible();
  await expect(page.getByText("compatibility:downgraded via policy - provider_variant_unavailable")).toBeVisible();
  await expect(page.getByText("child supervision:total=3 active=1 waiting=1 completed=2 failed=0")).toBeVisible();
  await expect(page.getByText(/child blocker chain:.*ops-approval-child-thread.*ops-delegation-approval/i)).toBeVisible();
  await expect(page.getByText("fan-in checkpoint:not recorded")).toBeVisible();
});

test("ops detail pages degrade cleanly when optional structured data is absent", async ({ page }) => {
  await openRunDetail(page, OPS_FIXTURE_IDS.stalled.runId);

  await expect(page.getByText("No approval chain recorded.")).toBeVisible();
  await expect(page.getByText("No delegation lineage recorded.")).toBeVisible();
  await expect(page.getByText("No compaction history recorded.")).toBeVisible();
});

test("ops run detail surfaces explicit user-input wait blockers", async ({ page }) => {
  await openRunDetail(page, OPS_FIXTURE_IDS.userInput.runId);

  await expect(page.getByRole("heading", { name: "Blocking" })).toBeVisible();
  await expect(page.getByText("event:user.reply")).toBeVisible();
  await expect(page.getByText("user_input user.reply")).toBeVisible();
  await expect(page.getByTestId("ops-blocking-detail")).toHaveText("Clarify the target report format.");
});

test("ops run detail surfaces mode-switch wait blockers with deterministic guidance copy", async ({ page }) => {
  await openRunDetail(page, OPS_FIXTURE_IDS.modeBlocked.runId);

  await expect(page.getByRole("heading", { name: "Blocking" })).toBeVisible();
  await expect(page.getByText("event:user.mode_switch")).toBeVisible();
  await expect(page.getByText("user.mode_switch", { exact: true })).toBeVisible();
  await expect(page.getByText("Wait for user_input.")).toBeVisible();
});

async function openRunDetail(page: Page, runId: string): Promise<void> {
  await page.goto(`/ops/runs/${runId}`);
  const notFound = page.getByRole("alert").filter({ hasText: "Run not found." });
  if (await notFound.count()) {
    await page.reload();
  }
}
