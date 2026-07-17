import { execFileSync } from "node:child_process";
import process from "node:process";

export const THEME_TOKEN_NAMES = [
  "bg",
  "panel",
  "panelAlt",
  "panelSoft",
  "text",
  "muted",
  "brand",
  "brandAlt",
  "brandSoft",
  "bubbleUser",
  "bubbleAssistant",
  "bubbleSystem",
  "warn",
  "error",
  "success",
] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];

export interface ThemeTokens {
  bg: string;
  panel: string;
  panelAlt: string;
  panelSoft: string;
  text: string;
  muted: string;
  brand: string;
  brandAlt: string;
  brandSoft: string;
  bubbleUser: string;
  bubbleAssistant: string;
  bubbleSystem: string;
  warn: string;
  error: string;
  success: string;
}

export type ThemeOverrides = Partial<ThemeTokens>;

export type ThemePresetId = "paper-sky" | "midnight-flight" | "amber-watch";
export type ThemeMode = "light" | "dark" | "system";
export type ResolvedThemeMode = "light" | "dark";

export const LIGHT_THEME_PRESET_ID: ThemePresetId = "paper-sky";
export const DARK_THEME_PRESET_ID: ThemePresetId = "midnight-flight";
export const DEFAULT_THEME_MODE: ThemeMode = "system";

export const DEFAULT_THEME: ThemeTokens = {
  bg: "#0A0A0A",
  panel: "#141414",
  panelAlt: "#303030",
  panelSoft: "#101010",
  text: "#F2F0EA",
  muted: "#A09D96",
  brand: "#C1121F",
  brandAlt: "#F2F0EA",
  brandSoft: "#303030",
  bubbleUser: "#141414",
  bubbleAssistant: "#141414",
  bubbleSystem: "#1A1A1A",
  warn: "#B89B4B",
  error: "#D65A50",
  success: "#7AA083",
};

export const THEME_PRESETS: Record<ThemePresetId, ThemeTokens> = {
  "paper-sky": {
    bg: "#F2F0EA",
    panel: "#E7E4DC",
    panelAlt: "#C9C4B8",
    panelSoft: "#ECE9E2",
    text: "#0A0A0A",
    muted: "#6F6B63",
    brand: "#C1121F",
    brandAlt: "#0A0A0A",
    brandSoft: "#C9C4B8",
    bubbleUser: "#E7E4DC",
    bubbleAssistant: "#E7E4DC",
    bubbleSystem: "#DDD8CE",
    warn: "#7D651E",
    error: "#A33A32",
    success: "#3F7A4F",
  },
  "midnight-flight": {
    bg: "#0A0A0A",
    panel: "#141414",
    panelAlt: "#303030",
    panelSoft: "#101010",
    text: "#F2F0EA",
    muted: "#A09D96",
    brand: "#C1121F",
    brandAlt: "#F2F0EA",
    brandSoft: "#303030",
    bubbleUser: "#141414",
    bubbleAssistant: "#141414",
    bubbleSystem: "#1A1A1A",
    warn: "#B89B4B",
    error: "#D65A50",
    success: "#7AA083",
  },
  "amber-watch": {
    bg: "#0B0905",
    panel: "#16120A",
    panelAlt: "#342817",
    panelSoft: "#120E08",
    text: "#F4E8C8",
    muted: "#A89772",
    brand: "#D08500",
    brandAlt: "#F4E8C8",
    brandSoft: "#342817",
    bubbleUser: "#171209",
    bubbleAssistant: "#171209",
    bubbleSystem: "#1D170D",
    warn: "#D4A12B",
    error: "#D65A50",
    success: "#7AA083",
  },
};

export const DEFAULT_THEME_PRESET_ID: ThemePresetId = "paper-sky";

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/u;

let activeTheme: ThemeTokens = DEFAULT_THEME;

export const theme = new Proxy({ ...DEFAULT_THEME }, {
  get(_target, prop) {
    if (typeof prop !== "string") {
      return ;
    }
    return activeTheme[prop as keyof ThemeTokens];
  },
  ownKeys() {
    return Reflect.ownKeys(DEFAULT_THEME);
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop !== "string" || isThemeTokenName(prop) === false) {
      return ;
    }
    return {
      configurable: true,
      enumerable: true,
      value: activeTheme[prop],
      writable: false,
    };
  },
}) as ThemeTokens;

export type ThemeCommandPlan =
  | { kind: "show" }
  | { kind: "list" }
  | { kind: "set-mode"; mode: ThemeMode }
  | { kind: "help" }
  | { kind: "error"; message: string };

export interface ThemeSystemContext {
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  readMacOsAppearance?: (() => string | undefined) | undefined;
}

export interface ResolvedThemeSelection {
  mode: ThemeMode;
  resolvedMode: ResolvedThemeMode;
  preset: ThemePresetId;
  tokens: ThemeTokens;
}

export function setActiveTheme(next: ThemeTokens): void {
  activeTheme = next;
}

export function resolveThemeTokens(
  overrides?: ThemeOverrides | undefined,
  baseTheme: ThemeTokens = DEFAULT_THEME,
): ThemeTokens {
  const resolved: ThemeTokens = { ...baseTheme };
  const resolvedOverrides = overrides ?? {};
  for (const token of THEME_TOKEN_NAMES) {
    const value = resolvedOverrides[token];
    if (value !== undefined) {
      resolved[token] = normalizeThemeColor(value) ?? baseTheme[token];
    }
  }
  return resolved;
}

export function isThemePresetId(value: string): value is ThemePresetId {
  return value in THEME_PRESETS;
}

export function isThemeMode(value: string): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

export function listThemePresetIds(): ThemePresetId[] {
  return Object.keys(THEME_PRESETS) as ThemePresetId[];
}

export function listThemeModes(): ThemeMode[] {
  return ["light", "dark", "system"];
}

export function resolveThemePreset(preset: ThemePresetId): ThemeTokens {
  return { ...THEME_PRESETS[preset] };
}

export function resolveThemeConfig(input: {
  preset?: ThemePresetId | undefined;
  overrides?: ThemeOverrides | undefined;
}): ThemeTokens {
  return resolveThemeTokens(
    input.overrides,
    resolveThemePreset(input.preset ?? DEFAULT_THEME_PRESET_ID),
  );
}

export function resolveThemeModePreference(
  mode: ThemeMode = DEFAULT_THEME_MODE,
  context: ThemeSystemContext = {},
): ResolvedThemeMode {
  const envMode = context.env?.KESTREL_TUI_COLOR_MODE;
  const preferredMode = envMode !== undefined && isThemeMode(envMode.trim())
    ? envMode.trim()
    : mode;

  if (preferredMode === "light" || preferredMode === "dark") {
    return preferredMode;
  }

  const platform = context.platform ?? process.platform;
  if (platform !== "darwin") {
    return "light";
  }

  const appearance = context.readMacOsAppearance !== undefined
    ? context.readMacOsAppearance()
    : readMacOsAppearance();
  return appearance?.trim() === "Dark" ? "dark" : "light";
}

export function presetForResolvedThemeMode(mode: ResolvedThemeMode): ThemePresetId {
  return mode === "dark" ? DARK_THEME_PRESET_ID : LIGHT_THEME_PRESET_ID;
}

export function themeModeFromLegacyPreset(preset: unknown): ThemeMode {
  if (preset === LIGHT_THEME_PRESET_ID) {
    return "light";
  }
  if (preset === DARK_THEME_PRESET_ID || preset === "amber-watch") {
    return "dark";
  }
  return DEFAULT_THEME_MODE;
}

export function resolveThemeSelection(input: {
  mode?: ThemeMode | undefined;
  overrides?: ThemeOverrides | undefined;
  systemContext?: ThemeSystemContext | undefined;
}): ResolvedThemeSelection {
  const mode = input.mode ?? DEFAULT_THEME_MODE;
  const resolvedMode = resolveThemeModePreference(mode, input.systemContext);
  const preset = presetForResolvedThemeMode(resolvedMode);
  return {
    mode,
    resolvedMode,
    preset,
    tokens: resolveThemeConfig({
      preset,
      overrides: input.overrides,
    }),
  };
}

export function isThemeTokenName(value: string): value is ThemeTokenName {
  return (THEME_TOKEN_NAMES as readonly string[]).includes(value);
}

export function isThemeColor(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value.trim());
}

export function normalizeThemeColor(value: string): string | undefined {
  const trimmed = value.trim();
  if (isThemeColor(trimmed) === false) {
    return ;
  }
  return trimmed.toUpperCase();
}

export function parseThemeCommandArgs(args: string[]): ThemeCommandPlan {
  const [subcommand] = args;

  if (subcommand === undefined || subcommand === "status") {
    return { kind: "show" };
  }
  if (subcommand === "list") {
    return { kind: "list" };
  }
  if (subcommand === "help") {
    return { kind: "help" };
  }
  if (isThemeMode(subcommand)) {
    return { kind: "set-mode", mode: subcommand };
  }

  return {
    kind: "error",
    message: "Theme commands: /theme, /theme list, /theme light, /theme dark, /theme system",
  };
}

export function buildThemeSummaryLines(input: {
  mode?: ThemeMode | undefined;
  resolvedMode?: ResolvedThemeMode | undefined;
  preset: ThemePresetId;
  effectiveTheme: ThemeTokens;
  overrides?: ThemeOverrides | undefined;
}): string[] {
  const overrides = input.overrides ?? {};
  return [
    ...(input.mode !== undefined ? [`mode=${input.mode}`] : []),
    ...(input.resolvedMode !== undefined ? [`resolved=${input.resolvedMode}`] : []),
    `preset=${input.preset}`,
    ...THEME_TOKEN_NAMES.map((token) => {
      const overrideValue = overrides[token];
      const source = overrideValue !== undefined ? "profile-override" : "preset";
      return `${token}=${input.effectiveTheme[token]} (${source})`;
    }),
  ];
}

function readMacOsAppearance(): string | undefined {
  try {
    return execFileSync("defaults", ["read", "-g", "AppleInterfaceStyle"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return ;
  }
}
