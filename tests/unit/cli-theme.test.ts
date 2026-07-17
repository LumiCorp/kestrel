import test from "node:test";
import assert from "node:assert/strict";

import {
  buildThemeSummaryLines,
  DEFAULT_THEME_PRESET_ID,
  THEME_PRESETS,
  parseThemeCommandArgs,
  resolveThemeModePreference,
  resolveThemeSelection,
  resolveThemeConfig,
  resolveThemeTokens,
  setActiveTheme,
  theme,
} from "../../cli/ink/theme/tokens.js";

test("resolveThemeTokens merges a base theme with overrides", () => {
  const resolved = resolveThemeTokens(
    {
      brandAlt: "#00ff00",
      warn: "#abcdef",
    },
    resolveThemeConfig({ preset: DEFAULT_THEME_PRESET_ID }),
  );

  assert.equal(resolved.brandAlt, "#00FF00");
  assert.equal(resolved.warn, "#ABCDEF");
  assert.equal(resolved.text, resolveThemeConfig({ preset: DEFAULT_THEME_PRESET_ID }).text);
});

test("theme presets keep status colors semantically distinct", () => {
  for (const [presetId, tokens] of Object.entries(THEME_PRESETS)) {
    assert.notEqual(tokens.warn, tokens.error, `${presetId} warn/error`);
    assert.notEqual(tokens.warn, tokens.success, `${presetId} warn/success`);
    assert.notEqual(tokens.error, tokens.success, `${presetId} error/success`);
  }
});

test("theme presets remain visually distinct", () => {
  assert.notDeepEqual(THEME_PRESETS["amber-watch"], THEME_PRESETS["midnight-flight"]);
});

test("parseThemeCommandArgs validates mode commands", () => {
  assert.deepEqual(parseThemeCommandArgs([]), { kind: "show" });
  assert.deepEqual(parseThemeCommandArgs(["list"]), { kind: "list" });
  assert.deepEqual(parseThemeCommandArgs(["dark"]), {
    kind: "set-mode",
    mode: "dark",
  });

  const invalidMode = parseThemeCommandArgs(["use", "paper-sky"]);
  assert.equal(invalidMode.kind, "error");
  if (invalidMode.kind === "error") {
    assert.match(invalidMode.message, /Theme commands/);
  }
});

test("resolveThemeModePreference uses env override before system detection", () => {
  assert.equal(
    resolveThemeModePreference("light", {
      env: { KESTREL_TUI_COLOR_MODE: "dark" },
      platform: "darwin",
      readMacOsAppearance: (): undefined => void 0,
    }),
    "dark",
  );
});

test("resolveThemeModePreference resolves macOS appearance for system mode", () => {
  assert.equal(
    resolveThemeModePreference("system", {
      env: {},
      platform: "darwin",
      readMacOsAppearance: () => "Dark\n",
    }),
    "dark",
  );
  assert.equal(
    resolveThemeModePreference("system", {
      env: {},
      platform: "darwin",
      readMacOsAppearance: (): undefined => void 0,
    }),
    "light",
  );
});

test("resolveThemeSelection maps modes to preset tokens and keeps overrides", () => {
  const selected = resolveThemeSelection({
    mode: "dark",
    overrides: { brandAlt: "#00ff00" },
  });

  assert.equal(selected.mode, "dark");
  assert.equal(selected.resolvedMode, "dark");
  assert.equal(selected.preset, "midnight-flight");
  assert.equal(selected.tokens.brandAlt, "#00FF00");
});

test("buildThemeSummaryLines marks preset and override provenance", () => {
  const effectiveTheme = resolveThemeConfig({
    preset: "paper-sky",
    overrides: { brandAlt: "#00FF00" },
  });
  const lines = buildThemeSummaryLines({
    mode: "light",
    resolvedMode: "light",
    preset: "paper-sky",
    effectiveTheme,
    overrides: { brandAlt: "#00FF00" },
  });

  assert.equal(lines[0], "mode=light");
  assert.equal(lines[1], "resolved=light");
  assert.equal(lines[2], "preset=paper-sky");
  assert.equal(lines.includes("brandAlt=#00FF00 (profile-override)"), true);
  assert.equal(lines.some((line) => line.endsWith("(preset)")), true);
});

test("theme proxy reflects the active theme", () => {
  const nextTheme = resolveThemeConfig({
    preset: "midnight-flight",
    overrides: { brandAlt: "#00FF00" },
  });
  setActiveTheme(nextTheme);
  assert.equal(theme.brandAlt, "#00FF00");
  setActiveTheme(resolveThemeConfig({ preset: DEFAULT_THEME_PRESET_ID }));
});
