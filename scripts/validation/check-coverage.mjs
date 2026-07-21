import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const coverageRoot = path.resolve(process.argv[2] ?? "test-results/validation/coverage");
const baseline = JSON.parse(readFileSync(path.join(root, "tests/coverage-baseline.json"), "utf8"));
const scripts = new Map();

for (const file of walk(coverageRoot)) {
  if (!file.endsWith(".json")) continue;
  const payload = JSON.parse(readFileSync(file, "utf8"));
  for (const script of payload.result ?? []) {
    if (!script.url?.startsWith("file:")) continue;
    const absolute = fileURLToPath(script.url).split("?")[0];
    if (!absolute.startsWith(root) || absolute.includes("/node_modules/")) continue;
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    const counters = scripts.get(relative) ?? { covered: 0, total: 0 };
    for (const fn of script.functions ?? []) {
      for (const range of fn.ranges ?? []) {
        counters.total += 1;
        if (range.count > 0) counters.covered += 1;
      }
    }
    scripts.set(relative, counters);
  }
}

const errors = [];
const components = {};
for (const component of baseline.components) {
  const entries = [...scripts].filter(([file]) => file.startsWith(component.prefix));
  const covered = entries.reduce((sum, [, value]) => sum + value.covered, 0);
  const total = entries.reduce((sum, [, value]) => sum + value.total, 0);
  const rangeCoverage = total === 0 ? 0 : covered / total;
  components[component.id] = { files: entries.length, coveredRanges: covered, totalRanges: total, rangeCoverage };
  if (rangeCoverage + Number.EPSILON < component.minimumRangeCoverage) {
    errors.push(`${component.id} range coverage ${percent(rangeCoverage)} is below ${percent(component.minimumRangeCoverage)}`);
  }
}

for (const critical of baseline.criticalModules) {
  const counters = scripts.get(critical.file);
  if (!counters || counters.covered === 0) errors.push(`${critical.file} did not execute`);
  else if (counters.total > 1 && counters.covered / counters.total < critical.minimumRangeCoverage) {
    errors.push(`${critical.file} branch/range signal ${percent(counters.covered / counters.total)} is below ${percent(critical.minimumRangeCoverage)}`);
  }
}

const report = {
  version: 1,
  model: "V8 function and block ranges; component baselines are intentionally separate",
  components,
  criticalModules: baseline.criticalModules.map((item) => ({ ...item, observed: scripts.get(item.file) ?? null })),
  uncoveredSourceFiles: [...scripts].filter(([, value]) => value.total > 0 && value.covered === 0).map(([file]) => file).sort(),
};
writeFileSync(path.join(path.dirname(coverageRoot), "coverage-summary.json"), `${JSON.stringify(report, null, 2)}\n`);

if (errors.length > 0) throw new Error(`Coverage contract failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
process.stdout.write(`[coverage] verified ${Object.keys(components).length} component baselines and ${baseline.criticalModules.length} critical modules\n`);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}
