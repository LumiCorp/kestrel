import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareHarnessEfficiencyPairsV2,
  parseHarnessEfficiencyResultV2,
  type HarnessEfficiencyResultV2,
} from "../src/economics/index.js";

export function loadHarnessEfficiencyResults(target: string): HarnessEfficiencyResultV2[] {
  if (existsSync(target) === false) throw new Error(`Efficiency result path does not exist: ${target}`);
  const files = statSync(target).isDirectory() ? listJsonFiles(target) : [target];
  const results: HarnessEfficiencyResultV2[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch {
      continue;
    }
    if ((parsed as { schema?: unknown })?.schema !== "kestrel.harness-efficiency-result/v2") continue;
    results.push(parseHarnessEfficiencyResultV2(parsed));
  }
  if (results.length === 0) throw new Error(`No harness efficiency results found under: ${target}`);
  return results;
}

export function runHarnessEfficiencyComparison(argv: string[], output: Pick<NodeJS.WriteStream, "write">): number {
  const options = parseArgs(argv);
  const comparison = compareHarnessEfficiencyPairsV2({
    baseline: loadHarnessEfficiencyResults(options.baseline),
    candidate: loadHarnessEfficiencyResults(options.candidate),
  });
  const serialized = JSON.stringify(comparison, null, 2) + "\n";
  if (options.out === undefined) output.write(serialized);
  else writeFileSync(options.out, serialized, "utf8");
  return comparison.passed ? 0 : 2;
}

function parseArgs(argv: string[]): { baseline: string; candidate: string; out?: string | undefined } {
  let baseline: string | undefined;
  let candidate: string | undefined;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--baseline") baseline = readArg(argv, ++index, arg);
    else if (arg === "--candidate") candidate = readArg(argv, ++index, arg);
    else if (arg === "--out") out = readArg(argv, ++index, arg);
    else throw new Error(`Unknown argument: ${String(arg)}`);
  }
  if (baseline === undefined || candidate === undefined) throw new Error("Usage: --baseline <file-or-directory> --candidate <file-or-directory> [--out <file>]");
  return { baseline, candidate, ...(out !== undefined ? { out } : {}) };
}

function readArg(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function listJsonFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listJsonFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(target);
  }
  return files.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runHarnessEfficiencyComparison(process.argv.slice(2), process.stdout);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
