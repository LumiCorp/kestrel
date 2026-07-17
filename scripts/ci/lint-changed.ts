import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const read = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const base = read("--base", process.env.CI_BASE_SHA ?? "origin/main");
const head = read("--head", process.env.CI_HEAD_SHA ?? "HEAD");
const supported = /\.(?:cjs|css|js|json|jsonc|jsx|mjs|ts|tsx)$/u;
const paths = execFileSync(
  "git",
  ["diff", "--name-only", "--diff-filter=ACMR", "-z", base, head],
  { encoding: "utf8" }
)
  .split("\0")
  .filter((path) => supported.test(path))
  .map((path) => resolve(path));

if (paths.length === 0) {
  process.stdout.write("No changed supported files require Ultracite.\n");
} else {
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@kestrel/kestrel-one",
      "exec",
      "ultracite",
      "check",
      ...paths,
    ],
    { stdio: "inherit" }
  );
}
