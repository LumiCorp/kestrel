import { existsSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_HERMETIC_LANE_IDS } from "./validation/runtime-hermetic-lanes.mjs";

if (isMainModule()) publishValidationSummary();

function publishValidationSummary() {
  const reportPath = path.resolve("test-results/validation/report.json");
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  if (!summaryPath) {
    process.stdout.write(
      "[validation-summary] GITHUB_STEP_SUMMARY is not set\n",
    );
    return;
  }

  if (!existsSync(reportPath)) {
    appendFileSync(
      summaryPath,
      [
        "## Kestrel Validation",
        "",
        "`test-results/validation/report.json` was not produced.",
        "",
      ].join("\n"),
    );
    return;
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  appendFileSync(summaryPath, renderValidationSummary(report));
}

export function renderValidationSummary(report) {
  const measurements = Array.isArray(report.measurements)
    ? report.measurements
    : [];
  const slowestTasks = Array.isArray(report.slowestTasks)
    ? report.slowestTasks.slice(0, 8)
    : [];
  const phases = measurements.filter((item) => item.kind === "phase");
  const tasksByName = new Map(
    measurements
      .filter((item) => item.kind === "task")
      .map((item) => [item.name, item]),
  );

  const lines = [
    "## Kestrel Validation",
    "",
    `Status: \`${report.status ?? "unknown"}\``,
    `Duration: \`${formatMs(report.durationMs)}\``,
    `Managed process launches: \`${report.telemetry?.managedProcessLaunches ?? "unknown"}\``,
    "",
    "### Phases",
    "",
    "| Phase | Duration |",
    "| --- | ---: |",
    ...phases.map(
      (item) => `| ${escapeCell(item.name)} | ${formatMs(item.durationMs)} |`,
    ),
    "",
    "### Runtime Lanes",
    "",
    "| Lane | Duration |",
    "| --- | ---: |",
    ...RUNTIME_HERMETIC_LANE_IDS.map((lane) => {
      const measurement = tasksByName.get(`runtime/${lane} hermetic`);
      return `| ${escapeCell(lane)} | ${formatMs(measurement?.durationMs)} |`;
    }),
    "",
    "### Slowest Tasks",
    "",
    "| Task | Phase | Duration |",
    "| --- | --- | ---: |",
    ...slowestTasks.map(
      (item) =>
        `| ${escapeCell(item.name)} | ${escapeCell(item.phase ?? "")} | ${formatMs(item.durationMs)} |`,
    ),
    "",
  ];

  if (report.error) {
    lines.push(
      "### Error",
      "",
      `\`${String(report.error).replaceAll("`", "'")}\``,
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}

function formatMs(value) {
  return Number.isFinite(value) ? `${(value / 1000).toFixed(1)}s` : "unknown";
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function isMainModule() {
  return process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;
}
