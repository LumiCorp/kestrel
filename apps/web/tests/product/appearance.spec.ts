import { expect, test } from "@playwright/test";
import { contractTest } from "../contract-test.js";

test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  await page.goto("/settings/appearance");
  await expect(
    page.getByRole("heading", { level: 2, name: "Appearance" })
  ).toBeVisible();
});

contractTest(
  "web.appearance-palettes",
  "Appearance settings keep light and dark palettes independent and durable",
  async ({ page }) => {
    const root = page.locator("html");
    const lightPalettes = page.getByRole("radiogroup", {
      name: "Light palette",
    });
    const darkPalettes = page.getByRole("radiogroup", {
      name: "Dark palette",
    });

    await page.getByRole("radio", { name: "Light" }).check();
    await lightPalettes.getByRole("radio", { name: "Juniper" }).check();
    await expect(root).toHaveAttribute("data-light-palette", "juniper");
    await expect(root).not.toHaveClass(/dark/u);

    const lightBackground = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--background")
        .trim()
    );
    await darkPalettes.getByRole("radio", { name: "Iris" }).check();
    await expect(root).toHaveAttribute("data-dark-palette", "iris");
    await expect(root).not.toHaveClass(/dark/u);
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--background")
          .trim()
      )
    ).toBe(lightBackground);

    await page.reload();
    await expect(root).toHaveAttribute("data-light-palette", "juniper");
    await expect(root).toHaveAttribute("data-dark-palette", "iris");
    await expect(lightPalettes.getByRole("radio", { name: "Juniper" })).toBeChecked();
    await expect(darkPalettes.getByRole("radio", { name: "Iris" })).toBeChecked();

    await page.getByRole("radio", { name: "Dark" }).check();
    await expect(root).toHaveClass(/dark/u);
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--background")
          .trim()
      )
    ).not.toBe(lightBackground);
  }
);

contractTest(
  "web.appearance-palette-recovery",
  "Appearance settings recover invalid storage and synchronize open tabs",
  async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem(
        "kestrel-one.palette-preferences.v1",
        JSON.stringify({ light: "unknown", dark: "harbor" })
      );
    });
    await page.reload();
    const root = page.locator("html");
    await expect(root).toHaveAttribute("data-light-palette", "lumi");
    await expect(root).toHaveAttribute("data-dark-palette", "harbor");

    const secondPage = await page.context().newPage();
    await secondPage.goto("/settings/appearance");
    await expect(
      secondPage.getByRole("heading", { level: 2, name: "Appearance" })
    ).toBeVisible();

    await page
      .getByRole("radiogroup", { name: "Light palette" })
      .getByRole("radio", { name: "Graphite" })
      .check();
    await expect(secondPage.locator("html")).toHaveAttribute(
      "data-light-palette",
      "graphite"
    );
    await expect(
      secondPage
        .getByRole("radiogroup", { name: "Light palette" })
        .getByRole("radio", { name: "Graphite" })
    ).toBeChecked();

    const graphite = page
      .getByRole("radiogroup", { name: "Light palette" })
      .getByRole("radio", { name: "Graphite" });
    await graphite.focus();
    await graphite.press("ArrowRight");
    const harbor = page
      .getByRole("radiogroup", { name: "Light palette" })
      .getByRole("radio", { name: "Harbor" });
    await expect(harbor).toBeFocused();
    await harbor.press("Space");
    await expect(harbor).toBeChecked();
  }
);
