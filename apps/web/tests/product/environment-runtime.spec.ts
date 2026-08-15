import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_PRODUCT_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("KESTREL_PRODUCT_DATABASE_URL is required.");
}

test("Environment Runtime surfaces select a canary and track an explicit update", async ({
  page,
  request,
}) => {
  const signInResponse = await request.post("/api/auth/sign-in/email", {
    data: {
      email: "admin@dev.local",
      password: "devpass123",
      rememberMe: true,
    },
  });
  expect(signInResponse.ok()).toBe(true);

  const environmentResponse = await request.get(
    "/api/organization/environments",
  );
  expect(environmentResponse.ok()).toBe(true);
  const environmentPayload = (await environmentResponse.json()) as {
    environments?: Array<{ id: string; name: string }>;
  };
  const environment = environmentPayload.environments?.[0];
  expect(environment).toBeTruthy();
  if (!environment) return;

  const database = postgres(databaseUrl, { prepare: false, max: 1 });
  const versionId = `product-runtime-${randomUUID()}`;
  const workspaceImage =
    `ghcr.io/lumicorp/kestrel-workspace-runtime@sha256:${"a".repeat(64)}`;
  const routerImage =
    `ghcr.io/lumicorp/kestrel-environment-router@sha256:${"b".repeat(64)}`;
  const previousWorkspaceImage =
    `ghcr.io/lumicorp/kestrel-workspace-runtime@sha256:${"c".repeat(64)}`;
  const previousRouterImage =
    `ghcr.io/lumicorp/kestrel-environment-router@sha256:${"d".repeat(64)}`;
  const [environmentBefore] = await database<EnvironmentBefore[]>`
    SELECT
      provider,
      status,
      runtime_image AS "runtimeImage",
      router_image AS "routerImage"
    FROM environments
    WHERE id = ${environment.id}
  `;
  const [channelBefore] = await database<ChannelBefore[]>`
    SELECT
      current_version_id AS "currentVersionId",
      previous_version_id AS "previousVersionId",
      canary_environment_id AS "canaryEnvironmentId",
      generation,
      last_github_run_id AS "lastGithubRunId",
      last_github_run_attempt AS "lastGithubRunAttempt",
      updated_at AS "updatedAt"
    FROM environment_runtime_channels
    WHERE name = 'production'
  `;
  expect(environmentBefore).toBeTruthy();
  expect(channelBefore).toBeTruthy();
  if (!(environmentBefore && channelBefore)) {
    await database.end();
    return;
  }

  try {
    await database.begin(async (transaction) => {
      await transaction`
        INSERT INTO environment_runtime_versions (
          id,
          workspace_runtime_image,
          workspace_runtime_source_revision,
          environment_router_image,
          environment_router_source_revision
        ) VALUES (
          ${versionId},
          ${workspaceImage},
          ${"1".repeat(40)},
          ${routerImage},
          ${"2".repeat(40)}
        )
      `;
      await transaction`
        UPDATE environment_runtime_channels
        SET
          current_version_id = ${versionId},
          previous_version_id = ${channelBefore.currentVersionId},
          canary_environment_id = NULL,
          generation = generation + 1,
          last_github_run_id = NULL,
          last_github_run_attempt = NULL,
          updated_at = now()
        WHERE name = 'production'
      `;
      await transaction`
        UPDATE environments
        SET
          provider = 'fly',
          status = 'ready',
          runtime_image = ${previousWorkspaceImage},
          router_image = ${previousRouterImage}
        WHERE id = ${environment.id}
      `;
    });

    await page.goto("/platform/runtime");
    await expect(
      page.getByRole("heading", { level: 1, name: "Environment Runtime" }),
    ).toBeVisible();
    await expect(page.getByText(versionId, { exact: true })).toBeVisible();
    await page
      .getByLabel("Production canary Environment")
      .selectOption(environment.id);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Production canary updated.")).toBeVisible();

    const operationId = randomUUID();
    await page.route(
      `**/api/organization/environments/${environment.id}/runtime-updates`,
      async (route) => {
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            operation: {
              id: operationId,
              status: "queued",
              stage: "environment.update.requested",
              errorMessage: null,
            },
          }),
        });
      },
    );
    await page.route(
      `**/api/organization/environments/${environment.id}/operations`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            operations: [
              {
                id: operationId,
                status: "completed",
                stage: "environment.update.ready",
                errorMessage: null,
              },
            ],
          }),
        });
      },
    );

    await page.goto(`/organization/environments/${environment.id}/runtime`);
    await expect(
      page.getByText("Update available", { exact: true }).first(),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Update to current runtime" })
      .click();
    await expect(page.getByText("Runtime update queued.")).toBeVisible();
    await expect(page.getByText("Runtime update completed.")).toBeVisible();

    await page.route(
      `**/api/organization/environments/${environment.id}/runtime-updates`,
      async (route) => {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: { message: "Another lifecycle operation is active." },
          }),
        });
      },
      { times: 1 },
    );
    await page
      .getByRole("button", { name: "Update to current runtime" })
      .click();
    await expect(
      page.getByText("Another lifecycle operation is active."),
    ).toBeVisible();

    await database`
      UPDATE environments
      SET runtime_image = ${workspaceImage}, router_image = ${routerImage}
      WHERE id = ${environment.id}
    `;
    await page.reload();
    await expect(
      page.getByText("Current", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Runtime is current" }),
    ).toBeDisabled();
  } finally {
    await database.begin(async (transaction) => {
      await transaction`
        UPDATE environment_runtime_channels
        SET
          current_version_id = ${channelBefore.currentVersionId},
          previous_version_id = ${channelBefore.previousVersionId},
          canary_environment_id = ${channelBefore.canaryEnvironmentId},
          generation = ${channelBefore.generation},
          last_github_run_id = ${channelBefore.lastGithubRunId},
          last_github_run_attempt = ${channelBefore.lastGithubRunAttempt},
          updated_at = ${channelBefore.updatedAt}
        WHERE name = 'production'
      `;
      await transaction`
        UPDATE environments
        SET
          provider = ${environmentBefore.provider},
          status = ${environmentBefore.status},
          runtime_image = ${environmentBefore.runtimeImage},
          router_image = ${environmentBefore.routerImage}
        WHERE id = ${environment.id}
      `;
      await transaction`
        DELETE FROM environment_runtime_versions WHERE id = ${versionId}
      `;
    });
    await database.end();
  }
});

type EnvironmentBefore = {
  provider: string;
  status: string;
  runtimeImage: string | null;
  routerImage: string | null;
};

type ChannelBefore = {
  currentVersionId: string | null;
  previousVersionId: string | null;
  canaryEnvironmentId: string | null;
  generation: number;
  lastGithubRunId: string | null;
  lastGithubRunAttempt: number | null;
  updatedAt: Date;
};
