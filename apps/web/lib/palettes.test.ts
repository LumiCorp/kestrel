import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PALETTE_PREFERENCES,
  PALETTE_FAMILIES,
  PALETTE_IDS,
  PALETTE_TOKEN_NAMES,
  parsePalettePreferences,
  parseStoredPalettePreferences,
} from "./palettes";

test("palette registry contains six complete light and dark families", () => {
  assert.equal(PALETTE_FAMILIES.length, 6);
  assert.deepEqual(
    PALETTE_FAMILIES.map((palette) => palette.id),
    PALETTE_IDS
  );

  for (const palette of PALETTE_FAMILIES) {
    for (const mode of ["light", "dark"] as const) {
      assert.deepEqual(
        Object.keys(palette[mode]).sort(),
        [...PALETTE_TOKEN_NAMES].sort(),
        `${palette.id}.${mode}`
      );
      for (const token of PALETTE_TOKEN_NAMES) {
        assert.match(palette[mode][token], /^#[0-9a-f]{6}$/iu);
      }
    }
  }
});

test("palette preferences validate each field independently", () => {
  assert.deepEqual(parsePalettePreferences(null), DEFAULT_PALETTE_PREFERENCES);
  assert.deepEqual(
    parsePalettePreferences({ light: "harbor", dark: "not-a-palette" }),
    { light: "harbor", dark: "lumi" }
  );
  assert.deepEqual(
    parsePalettePreferences({ light: "ember", dark: "iris" }),
    { light: "ember", dark: "iris" }
  );
});

test("stored palette preferences fall back safely", () => {
  assert.deepEqual(
    parseStoredPalettePreferences('{"light":"juniper","dark":"graphite"}'),
    { light: "juniper", dark: "graphite" }
  );
  assert.deepEqual(
    parseStoredPalettePreferences("not json"),
    DEFAULT_PALETTE_PREFERENCES
  );
  assert.deepEqual(
    parseStoredPalettePreferences(null),
    DEFAULT_PALETTE_PREFERENCES
  );
});

function channel(value: number) {
  const normalized = value / 255;
  return normalized <= 0.040_45
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string) {
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16)
  );
  return (
    0.2126 * channel(channels[0]) +
    0.7152 * channel(channels[1]) +
    0.0722 * channel(channels[2])
  );
}

function contrast(left: string, right: string) {
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("palette text pairs meet WCAG AA contrast", () => {
  const pairs = [
    ["foreground", "background"],
    ["card-foreground", "card"],
    ["popover-foreground", "popover"],
    ["primary-foreground", "primary"],
    ["secondary-foreground", "secondary"],
    ["muted-foreground", "muted"],
    ["accent-foreground", "accent"],
    ["sidebar-foreground", "sidebar"],
    ["sidebar-primary-foreground", "sidebar-primary"],
    ["sidebar-accent-foreground", "sidebar-accent"],
    ["surface-foreground", "surface"],
    ["code-foreground", "code"],
    ["selection-foreground", "selection"],
    ["message-user-foreground", "message-user"],
  ] as const;

  for (const palette of PALETTE_FAMILIES) {
    for (const mode of ["light", "dark"] as const) {
      for (const [foreground, background] of pairs) {
        const ratio = contrast(
          palette[mode][foreground],
          palette[mode][background]
        );
        assert.ok(
          ratio >= 4.5,
          `${palette.id}.${mode} ${foreground}/${background} is ${ratio.toFixed(2)}:1`
        );
      }
    }
  }
});

test("light palette user messages use softened surfaces with standard foreground text", () => {
  for (const palette of PALETTE_FAMILIES) {
    assert.notEqual(
      palette.light["message-user"],
      palette.light.primary,
      `${palette.id}.light user message surface should not use the saturated primary color`
    );
    assert.equal(
      palette.light["message-user-foreground"],
      palette.light.foreground,
      `${palette.id}.light user message text should use the standard readable foreground`
    );
  }
});

test("palette focus rings remain visible against application surfaces", () => {
  for (const palette of PALETTE_FAMILIES) {
    for (const mode of ["light", "dark"] as const) {
      for (const surface of ["background", "card", "sidebar"] as const) {
        const ratio = contrast(palette[mode].ring, palette[mode][surface]);
        assert.ok(
          ratio >= 3,
          `${palette.id}.${mode} ring/${surface} is ${ratio.toFixed(2)}:1`
        );
      }
    }
  }
});

test("monochrome brand tones meet AA contrast on shell and auth surfaces", () => {
  for (const palette of PALETTE_FAMILIES) {
    for (const surface of ["background", "sidebar"] as const) {
      const lightRatio = contrast("#111111", palette.light[surface]);
      assert.ok(
        lightRatio >= 4.5,
        `${palette.id}.light black brand/${surface} is ${lightRatio.toFixed(2)}:1`
      );

      const darkRatio = contrast("#ffffff", palette.dark[surface]);
      assert.ok(
        darkRatio >= 4.5,
        `${palette.id}.dark white brand/${surface} is ${darkRatio.toFixed(2)}:1`
      );
    }
  }
});
