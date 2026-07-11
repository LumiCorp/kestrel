import React, { useMemo } from "react";
import { Box, Text } from "ink";

import type { SplashPreflightCheck, SplashPreflightCheckState, SplashPreflightState } from "../../contracts.js";
import { theme } from "../theme/tokens.js";
import { truncate } from "../ui/format.js";

interface SplashGateProps {
  visible: boolean;
  onDismiss: () => void;
  preflight: SplashPreflightState;
}

export function SplashGate(props: SplashGateProps): React.JSX.Element | null {
  const palette = useMemo(() => resolveSplashPalette(props.preflight.phase), [props.preflight.phase]);
  const terminalWidth = typeof process.stdout.columns === "number" ? process.stdout.columns : 120;
  const availableWidth = Math.max(20, terminalWidth - 6);
  const layout = useMemo(() => buildSplashLayout(availableWidth), [availableWidth]);
  const art = layout.art;
  const artWidth = useMemo(() => calculateBlockWidth(art), [art]);
  const innerWidth = Math.max(12, availableWidth - layout.paddingX * 2 - 2);
  const contentWidth = Math.max(artWidth, Math.min(innerWidth, 44));
  const ledgerLayout = useMemo(
    () => resolveLedgerLayout(contentWidth, props.preflight.checks),
    [contentWidth, props.preflight.checks],
  );
  const promptLines = useMemo(
    () =>
      props.preflight.phase === "ready"
        ? ["Press Space to continue"]
        : wrapSplashText(props.preflight.summary, contentWidth),
    [contentWidth, props.preflight.phase, props.preflight.summary],
  );

  if (props.visible === false) {
    return null;
  }

  return (
    <Box
      flexDirection="column"
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
      paddingX={2}
    >
      <Box
        flexDirection="column"
        alignItems="center"
        width={Math.min(availableWidth, contentWidth + layout.paddingX * 2 + 2)}
        borderStyle="round"
        borderColor={palette.border}
        paddingX={layout.paddingX}
        paddingY={layout.paddingY}
      >
        {layout.eyebrow ? (
          <Box marginBottom={layout.eyebrowGap} justifyContent="center" width={contentWidth}>
            <Text color={palette.prompt}>{layout.eyebrow}</Text>
          </Box>
        ) : null}
        <Box flexDirection="column" width={contentWidth}>
          {art.map((line, index) => (
            <Box key={`splash-row-${index}`} justifyContent="center" width={contentWidth}>
              {renderArtLine(line, palette)}
            </Box>
          ))}
        </Box>
        <Box marginTop={1} flexDirection="column" width={contentWidth}>
          {props.preflight.checks.map((check) => (
            <Box key={check.id} width={contentWidth}>
              {renderCheckRow(check, ledgerLayout, palette)}
            </Box>
          ))}
          <Box marginTop={1} width={contentWidth}>
            {renderSummaryRow(props.preflight, ledgerLayout, palette, contentWidth)}
          </Box>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column" alignItems="center" width={contentWidth}>
        {promptLines.map((line, index) => (
          <Box key={`splash-prompt-${index}`} justifyContent="center" width={contentWidth}>
            <Text color={resolvePromptColor(props.preflight.phase, palette)}>{line}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

interface FramePalette {
  border: string;
  fill: string;
  dot: string;
  prompt: string;
}

interface SplashLayout {
  art: string[];
  eyebrow?: string;
  paddingX: number;
  paddingY: number;
  eyebrowGap: number;
}

interface LedgerLayout {
  labelWidth: number;
  fillerWidth: number;
  valueWidth: number;
}

const HERO_GLYPHS: Record<string, string[]> = {
  K: [
    "██  ██",
    "██ ██ ",
    "████  ",
    "██ ██ ",
    "██  ██",
  ],
  E: [
    "██████",
    "██    ",
    "█████ ",
    "██    ",
    "██████",
  ],
  S: [
    " █████",
    "██    ",
    " ████ ",
    "    ██",
    "█████ ",
  ],
  T: [
    "███████",
    "  ██   ",
    "  ██   ",
    "  ██   ",
    "  ██   ",
  ],
  R: [
    "█████ ",
    "██  ██",
    "█████ ",
    "██ ██ ",
    "██  ██",
  ],
  L: [
    "██    ",
    "██    ",
    "██    ",
    "██    ",
    "██████",
  ],
};

function resolveSplashPalette(phase: SplashPreflightState["phase"]): FramePalette {
  if (phase === "failed") {
    return {
      border: "#D96C5F",
      fill: "#D96C5F",
      dot: "#A84A44",
      prompt: "#D96C5F",
    };
  }

  return {
    border: "#FF6A00",
    fill: "#FF7E1B",
    dot: "#FF4A0A",
    prompt: "#FF8E2B",
  };
}

function buildSplashLayout(availableWidth: number): SplashLayout {
  if (availableWidth >= 72) {
    return {
      art: buildHeroWordmark("KESTREL"),
      eyebrow: "AUTONOMOUS RUNTIME // OPERATOR SHELL",
      paddingX: 3,
      paddingY: 1,
      eyebrowGap: 1,
    };
  }

  if (availableWidth >= 34) {
    return {
      art: ["K E S T R E L"],
      eyebrow: "AUTONOMOUS RUNTIME",
      paddingX: 2,
      paddingY: 1,
      eyebrowGap: 0,
    };
  }

  return {
    art: ["KESTREL"],
    paddingX: 1,
    paddingY: 0,
    eyebrowGap: 0,
  };
}

function buildHeroWordmark(value: string): string[] {
  return value.split("").reduce<string[]>((rows, character, index) => {
    const glyph = HERO_GLYPHS[character] ?? [character];
    if (index === 0) {
      return [...glyph];
    }
    return rows.map((row, rowIndex) => `${row}  ${glyph[rowIndex] ?? ""}`);
  }, []);
}

function calculateBlockWidth(lines: string[]): number {
  return lines.reduce((max, line) => Math.max(max, line.length), 0);
}

function renderArtLine(line: string, palette: FramePalette): React.JSX.Element {
  const segments = segmentArtLine(line, palette);
  return (
    <Text>
      {segments.map((segment, index) => (
        <Text key={`${segment.color}-${index}`} color={segment.color}>
          {segment.value}
        </Text>
      ))}
    </Text>
  );
}

function segmentArtLine(line: string, palette: FramePalette): Array<{ value: string; color: string }> {
  const segments: Array<{ value: string; color: string }> = [];
  let current = "";
  let currentColor: string | undefined;

  for (const char of line) {
    const color = resolveArtColor(char, palette);
    if (currentColor === color) {
      current += char;
      continue;
    }
    if (current.length > 0 && currentColor !== undefined) {
      segments.push({ value: current, color: currentColor });
    }
    current = char;
    currentColor = color;
  }

  if (current.length > 0 && currentColor !== undefined) {
    segments.push({ value: current, color: currentColor });
  }

  return segments;
}

function resolveArtColor(char: string, palette: FramePalette): string {
  if (char === "█" || char === "▓") {
    return palette.fill;
  }
  if (char === "▒" || char === "░") {
    return palette.dot;
  }
  if (char >= "A" && char <= "Z") {
    return palette.fill;
  }
  return theme.text;
}

function resolvePromptColor(phase: SplashPreflightState["phase"], palette: FramePalette): string {
  if (phase === "failed") {
    return theme.error;
  }
  if (phase === "ready") {
    return palette.prompt;
  }
  return theme.muted;
}

function renderCheckRow(
  check: SplashPreflightCheck,
  layout: LedgerLayout,
  palette: FramePalette,
): React.JSX.Element {
  const statusLabel = resolveCheckStateLabel(check.state);
  const label = truncate(check.label, layout.labelWidth).padEnd(layout.labelWidth, " ");
  const filler = ".".repeat(layout.fillerWidth);
  const value = statusLabel.padEnd(layout.valueWidth, " ");

  return (
    <Text>
      <Text color={theme.text}>{label}</Text>
      <Text color={theme.muted}> {filler} </Text>
      <Text color={resolveCheckColor(check.state, palette)}>{value}</Text>
    </Text>
  );
}

function renderSummaryRow(
  preflight: SplashPreflightState,
  layout: LedgerLayout,
  palette: FramePalette,
  contentWidth: number,
): React.JSX.Element {
  const label = (preflight.phase === "failed" ? "error" : "update").padEnd(layout.labelWidth, " ");
  const filler = ".".repeat(layout.fillerWidth);
  const indent = `${" ".repeat(layout.labelWidth)} ${" ".repeat(layout.fillerWidth)} `;
  const lines =
    preflight.phase === "failed"
      ? wrapSplashText(preflight.summary, Math.max(10, contentWidth - indent.length))
      : [truncate(preflight.summary, layout.valueWidth)];
  const firstValue = (lines[0] ?? "").padEnd(layout.valueWidth, " ");
  return (
    <Box flexDirection="column" width={contentWidth}>
      <Text>
        <Text color={theme.muted}>{label}</Text>
        <Text color={theme.muted}> {filler} </Text>
        <Text color={resolvePromptColor(preflight.phase, palette)}>{firstValue}</Text>
      </Text>
      {lines.slice(1).map((line, index) => (
        <Text key={`summary-wrap-${index}`}>
          <Text color={theme.muted}>{indent}</Text>
          <Text color={resolvePromptColor(preflight.phase, palette)}>{line}</Text>
        </Text>
      ))}
    </Box>
  );
}

function resolveLedgerLayout(width: number, checks: SplashPreflightCheck[]): LedgerLayout {
  const safeWidth = Math.max(20, width);
  const labelCandidate = Math.max(
    "update".length,
    "error".length,
    ...checks.map((check) => check.label.length),
  );
  const maxLabelWidth = Math.max(8, Math.floor(safeWidth * 0.28));
  const labelWidth = Math.min(labelCandidate, maxLabelWidth);
  const maxValueWidth = Math.max(10, safeWidth - labelWidth - 6);
  const valueWidth = Math.min(24, maxValueWidth);
  const fillerWidth = Math.max(2, safeWidth - labelWidth - valueWidth - 2);

  return {
    labelWidth,
    fillerWidth,
    valueWidth,
  };
}

function resolveCheckStateLabel(state: SplashPreflightCheckState): string {
  if (state === "pending") {
    return "WAIT";
  }
  if (state === "running") {
    return "RUN";
  }
  if (state === "ok") {
    return "OK";
  }
  if (state === "warn") {
    return "WARN";
  }
  if (state === "fail") {
    return "FAIL";
  }
  return "SKIP";
}

function resolveCheckColor(state: SplashPreflightCheckState, palette: FramePalette): string {
  if (state === "ok") {
    return theme.success;
  }
  if (state === "warn") {
    return theme.warn;
  }
  if (state === "fail") {
    return theme.error;
  }
  if (state === "running") {
    return palette.prompt;
  }
  if (state === "skip") {
    return theme.muted;
  }
  return theme.text;
}

function wrapSplashText(value: string, width: number): string[] {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return [""];
  }

  const safeWidth = Math.max(8, width);
  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (word.length > safeWidth) {
      if (current.length > 0) {
        lines.push(current);
        current = "";
      }
      for (let index = 0; index < word.length; index += safeWidth) {
        lines.push(word.slice(index, index + safeWidth));
      }
      continue;
    }

    const next = current.length === 0 ? word : `${current} ${word}`;
    if (next.length <= safeWidth) {
      current = next;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
}
