import { fileURLToPath } from "node:url";
import type { PromptSuiteSummary } from "../tests/scenario/promptSuiteHarness.js";
import { runPromptSuite } from "../tests/scenario/promptSuiteHarness.js";

async function main(): Promise<void> {
  const repeats = parsePositiveInt(process.env.PROMPT_SUITE_REPEATS, 3);
  const profile = parsePromptSuiteProfile(process.env.PROMPT_SUITE_PROFILE);
  const profileThresholds = promptSuiteThresholdsFor(profile);
  const minPassRate = Number.parseFloat(
    process.env.PROMPT_SUITE_MIN_PASS_RATE ?? String(profileThresholds.passRate)
  );
  const minComposite = Number.parseFloat(
    process.env.PROMPT_SUITE_MIN_COMPOSITE ??
      String(profileThresholds.composite)
  );

  const summary = await runPromptSuite(repeats, profile);

  process.stdout.write(
    `prompt-suite total=${summary.total} passed=${summary.passed} failed=${summary.failed} passRate=${summary.passRate}\n`
  );
  process.stdout.write(
    `  quality profile=${summary.threshold_profile} correctness=${summary.quality.correctness} latency=${summary.quality.latency} tool_efficiency=${summary.quality.tool_efficiency} recovery=${summary.quality.recovery} cost=${summary.quality.cost} composite=${summary.quality.composite}\n`
  );
  process.stdout.write(
    `  failure-classes ${Object.entries(summary.byFailureClass)
      .map(([name, stat]) => `${name}:${stat.passRate}`)
      .join(" ")}\n`
  );

  for (const result of summary.results) {
    if (result.ok) {
      process.stdout.write(
        `  ok  - ${result.name} status=${result.status} tools=${result.telemetry.toolCalls} nonRuntimeTools=${result.nonRuntimeToolCalls} steps=${result.telemetry.stepsExecuted}\n`
      );
      continue;
    }

    process.stdout.write(
      `  fail- ${result.name} status=${result.status} nonRuntimeTools=${result.nonRuntimeToolCalls} called=${result.calledTools.join(",")} outputCodes=${result.outputErrorCodes.join(",")} outputErrors=${result.outputErrors.join(" | ")} errors=${result.errors.join(" | ")}\n`
    );
  }

  for (const failure of promptSuiteResultFailures(summary, {
    passRate: minPassRate,
    composite: minComposite,
  })) {
    process.stderr.write(`Prompt suite failed threshold: ${failure}\n`);
    process.exitCode = 1;
  }
}

export function promptSuiteResultFailures(
  summary: PromptSuiteSummary,
  thresholds: { passRate: number; composite: number }
): string[] {
  const failures: string[] = [];
  if (summary.total <= 0) failures.push("total must be positive");
  if (summary.passed + summary.failed !== summary.total) {
    failures.push("passed plus failed must equal total");
  }
  if (!Number.isFinite(summary.passRate))
    failures.push("passRate must be finite");
  if (!Number.isFinite(summary.quality.composite))
    failures.push("quality.composite must be finite");
  if (summary.passRate < thresholds.passRate) {
    failures.push(`passRate=${summary.passRate} < min=${thresholds.passRate}`);
  }
  if (summary.quality.composite < thresholds.composite) {
    failures.push(
      `composite=${summary.quality.composite} < min=${thresholds.composite}`
    );
  }
  return failures;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) === false || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function parsePromptSuiteProfile(
  value: string | undefined
): "fast" | "stable" | "release" {
  if (value === "fast" || value === "stable" || value === "release") {
    return value;
  }
  return "stable";
}

export function promptSuiteThresholdsFor(
  profile: "fast" | "stable" | "release"
): { passRate: number; composite: number } {
  if (profile === "fast") {
    return { passRate: 0.82, composite: 70 };
  }
  if (profile === "release") {
    return { passRate: 0.96, composite: 86 };
  }
  return { passRate: 0.9, composite: 78 };
}

const entryPath = process.argv[1] === undefined ? undefined : process.argv[1];
if (entryPath === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(
      `prompt-suite runner failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
