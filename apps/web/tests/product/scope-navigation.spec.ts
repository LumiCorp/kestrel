import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

test.beforeEach(async ({ page, request }) => {
  const signInResponse = await request.post("/api/auth/sign-in/email", {
    data: {
      email: "admin@dev.local",
      password: "devpass123",
      rememberMe: true,
    },
  });
  expect(signInResponse.ok()).toBe(true);

  await page.context().addCookies([
    {
      name: "sidebar_state",
      value: "true",
      domain: "localhost",
      path: "/",
    },
  ]);
});

test("scope navigation stays ordered, collapsed, and organization-aware", async ({
  page,
}) => {
  await page.goto("/platform/users");

  const platform = page.getByRole("link", { name: "Platform", exact: true });
  const admin = page.getByRole("link", { name: "Admin", exact: true });
  const settings = page.getByRole("link", { name: "Settings", exact: true });

  await expect(platform).toHaveAttribute("aria-current", "page");
  await expect(admin).not.toHaveAttribute("aria-current", "page");
  await expect(settings).not.toHaveAttribute("aria-current", "page");
  const [platformBox, adminBox, settingsBox] = await Promise.all([
    platform.boundingBox(),
    admin.boundingBox(),
    settings.boundingBox(),
  ]);
  expect(platformBox?.y).toBeLessThan(adminBox?.y ?? 0);
  expect(adminBox?.y).toBeLessThan(settingsBox?.y ?? 0);

  await platform.focus();
  await page.keyboard.press("Tab");
  await expect(admin).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(settings).toBeFocused();

  await page.context().addCookies([
    {
      name: "sidebar_state",
      value: "false",
      domain: "localhost",
      path: "/",
    },
  ]);
  await page.reload();
  await platform.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Platform");

  await page.goto("/settings/profile");
  await expect(settings).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Switch organization" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Manage organization" }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: /Dev-org/u }).click();
  await expect(admin).toBeVisible();
  await page.getByRole("button", { name: "Switch organization" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Manage organization" }),
  ).toBeVisible();
});

test("scope navigation is available from the mobile drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/platform/users");
  await page.keyboard.press("Control+b");

  await expect(
    page.getByRole("link", { name: "Platform", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Admin", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Settings", exact: true }),
  ).toBeVisible();
});
