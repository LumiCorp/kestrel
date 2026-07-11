import { expect, test } from "@playwright/test";

test("sanity: test runner is configured", async () => {
  expect(1 + 1).toBe(2);
});

test("landing page stays public for unauthenticated visitors", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "Kestrel One" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "Sign In",
    })
  ).toBeVisible();
});
