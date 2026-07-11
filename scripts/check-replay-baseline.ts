import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ReplaySummary } from "../src/replay/RunReplayService.js";
import type { CapturedReplayBundle, ReplayBaseline } from "../src/governance/contracts.js";
import {
  diffCapturedReplayBundle,
  diffReplayAgainstBaseline,
} from "../src/governance/replayBaseline.js";

const ROOT = process.cwd();
const SINGLE_BASELINE_PATH = path.join(ROOT, "tests", "fixtures", "replay-baseline.json");
const SINGLE_CURRENT_PATH = path.join(ROOT, "tests", "fixtures", "replay-current.json");
const SINGLE_PREVIOUS_PATH = path.join(ROOT, "tests", "fixtures", "replay-previous.json");
const SUITE_DIR = path.join(ROOT, "tests", "fixtures", "replay-suite");

interface ReplayFixtureBundle {
  baseline: ReplayBaseline;
  current: {
    events: string[];
    summary: ReplaySummary;
    errorCodes?: string[] | undefined;
  };
  previous: {
    summary: ReplaySummary;
  };
}

async function main(): Promise<void> {
  const suiteFiles = await loadSuiteFiles();
  if (suiteFiles.length > 0) {
    const failed = await Promise.all(suiteFiles.map(checkSuiteCase));
    if (failed.some((item) => item === false)) {
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`[replay] validated ${suiteFiles.length} suite baseline(s)\n`);
    return;
  }

  const single = await loadSingleBundle();
  if (single === undefined) {
    process.stdout.write("[replay] baseline fixture not found; skipping\n");
    return;
  }

  const ok = reportViolations(single.baseline.scenario_id, diffReplayAgainstBaseline({
    baseline: single.baseline,
    events: single.current.events,
    summary: single.current.summary,
    previousSummary: single.previous.summary,
    errorCodes: single.current.errorCodes,
  }));
  if (ok === false) {
    process.exitCode = 1;
    return;
  }

  process.stdout.write("[replay] baseline checks passed\n");
}

async function loadSuiteFiles(): Promise<string[]> {
  try {
    return (await readdir(SUITE_DIR))
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(SUITE_DIR, name));
  } catch {
    return [];
  }
}

async function checkSuiteCase(filePath: string): Promise<boolean> {
  const payload = JSON.parse(await readFile(filePath, "utf8")) as ReplayFixtureBundle | CapturedReplayBundle;
  if ("manifest" in payload) {
    return reportViolations(payload.manifest.flow_id, diffCapturedReplayBundle({
      bundle: payload,
      events: payload.current.events,
      summary: payload.current.summary,
      errorCodes: payload.current.errorCodes,
      uiEvidenceArtifacts: payload.current.uiEvidenceArtifacts,
    }));
  }

  return reportViolations(payload.baseline.scenario_id, diffReplayAgainstBaseline({
    baseline: payload.baseline,
    events: payload.current.events,
    summary: payload.current.summary,
    previousSummary: payload.previous.summary,
    errorCodes: payload.current.errorCodes,
  }));
}

async function loadSingleBundle(): Promise<ReplayFixtureBundle | undefined> {
  try {
    const baseline = JSON.parse(await readFile(SINGLE_BASELINE_PATH, "utf8")) as ReplayBaseline;
    const current = JSON.parse(await readFile(SINGLE_CURRENT_PATH, "utf8")) as ReplayFixtureBundle["current"];
    const previous = JSON.parse(await readFile(SINGLE_PREVIOUS_PATH, "utf8")) as ReplayFixtureBundle["previous"];
    return {
      baseline,
      current,
      previous,
    };
  } catch {
    return undefined;
  }
}

function reportViolations(scenarioId: string, violations: Array<{ field: string; expected: unknown; actual: unknown }>): boolean {
  if (violations.length === 0) {
    process.stdout.write(`[replay] ${scenarioId} passed\n`);
    return true;
  }
  for (const violation of violations) {
    process.stderr.write(
      `[replay] ${scenarioId} ${violation.field} expected=${JSON.stringify(violation.expected)} actual=${JSON.stringify(violation.actual)}\n`,
    );
  }
  return false;
}

void main().catch((error) => {
  process.stderr.write(`check-replay-baseline failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
