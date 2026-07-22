import { randomUUID } from "node:crypto";
import { expect, type Locator, test } from "@playwright/test";
import { contractTest } from "../contract-test.js";

const PALETTES = ["Lumi", "Graphite", "Harbor", "Juniper", "Ember", "Iris"];

test.setTimeout(60_000);

async function expectLockupTone(
  locator: Locator,
  tone: "black" | "white"
) {
  const black = locator.locator(
    'img[src$="/brand/kestrel-one-lockup-black.svg"]'
  );
  const white = locator.locator(
    'img[src$="/brand/kestrel-one-lockup-white.svg"]'
  );
  await expect(tone === "black" ? black : white).toBeVisible();
  await expect(tone === "black" ? white : black).toBeHidden();
}

contractTest(
  "web.brand-auth-appearance",
  "authentication identity follows resolved appearance without duplication",
  async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => {
      if (!localStorage.getItem("theme")) {
        localStorage.setItem("theme", "system");
      }
    });
    await page.goto("/sign-in");

    const identity = page.getByRole("img", { name: "Kestrel One" });
    await expect(identity).toHaveCount(1);
    await expectLockupTone(identity, "white");
    await expect(page.locator('link[data-kestrel-favicon="active"]')).toHaveAttribute(
      "href",
      /favicon-dark\.ico$/u
    );

    await page.getByRole("tab", { name: "Sign Up" }).click();
    await expect(page.getByText("by Lumi Corp")).toBeVisible();
    await expect(page.getByRole("img", { name: "Kestrel One" })).toHaveCount(1);

    await page.evaluate(() => localStorage.setItem("theme", "light"));
    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/dark/u);
    await expectLockupTone(page.getByRole("img", { name: "Kestrel One" }), "black");
    await expect(page.locator('link[data-kestrel-favicon="active"]')).toHaveAttribute(
      "href",
      /favicon-light\.ico$/u
    );
  }
);

contractTest(
  "web.brand-sidebar-palettes",
  "sidebar identity adapts to collapse and appearance but not palette family",
  async ({ page }) => {
    const context = page.context();
    await context.addCookies([
      {
        name: "sidebar_state",
        value: "true",
        domain: "localhost",
        path: "/",
      },
    ]);
    await page.goto("/settings/appearance");

    const home = page.getByRole("link", { name: "Kestrel One home" });
    await expect(home).toBeVisible();
    await expectLockupTone(home, "black");

    await page.getByRole("radio", { name: "Light" }).check();
    for (const palette of PALETTES) {
      await page
        .getByRole("radiogroup", { name: "Light palette" })
        .getByRole("radio", { name: palette })
        .check();
      await home.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(home).toBeFocused();
      expect(await home.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
      await expectLockupTone(home, "black");
    }

    await page.getByRole("radio", { name: "Dark" }).check();
    for (const palette of PALETTES) {
      await page
        .getByRole("radiogroup", { name: "Dark palette" })
        .getByRole("radio", { name: palette })
        .check();
      await home.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(home).toBeFocused();
      expect(await home.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
      await expectLockupTone(home, "white");
    }

    await context.addCookies([
      {
        name: "sidebar_state",
        value: "false",
        domain: "localhost",
        path: "/",
      },
    ]);
    await page.reload();
    const collapsedHome = page.getByRole("link", { name: "Kestrel One home" });
    await expect(collapsedHome.locator('img[src$="/brand/kestrel-mark-white.svg"]')).toBeVisible();
    const collapsedLockups = collapsedHome.locator(
      'img[src*="kestrel-one-lockup"]'
    );
    await expect(collapsedLockups).toHaveCount(2);
    await expect(collapsedLockups.nth(0)).toBeHidden();
    await expect(collapsedLockups.nth(1)).toBeHidden();
    await expect(collapsedHome).toHaveAttribute("title", "Kestrel One home");
  }
);

contractTest(
  "web.brand-mobile-shared",
  "mobile drawer and public shared transcript use the canonical home identity",
  async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/appearance");
    await page.keyboard.press("Control+b");
    await expect(page.getByRole("link", { name: "Kestrel One home" })).toBeVisible();

    const threadId = randomUUID();
    await page.evaluate(async (id) => {
      const response = await fetch("/api/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, mode: "chat", projectId: null }),
      });
      if (!response.ok) throw new Error(await response.text());
    }, threadId);
    const shareToken = await page.evaluate(async (id) => {
      const response = await fetch(`/api/threads/${id}/share`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isPublic: true }),
      });
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()).shareToken as string;
    }, threadId);

    await page.goto(`/shared/${shareToken}`);
    const sharedHome = page.getByRole("link", { name: "Kestrel One home" });
    await expect(sharedHome).toBeVisible();
    await expect(page.getByRole("heading", { name: "Shared Thread" })).toBeVisible();
    await expectLockupTone(sharedHome, "black");
  }
);
