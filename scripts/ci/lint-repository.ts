import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const supported = /\.(?:cjs|css|js|json|jsonc|jsx|mjs|ts|tsx)$/u;
const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((path) => supported.test(path))
  .map((path) => resolve(path));

if (paths.length === 0) {
  throw new Error("No tracked source files were discovered for linting.");
}

process.stdout.write(
  `[static-policy] linting ${paths.length} tracked source files\n`
);
execFileSync(
  "pnpm",
  [
    "--filter",
    "@kestrel/kestrel-one",
    "exec",
    "biome",
    "lint",
    ...paths,
  ],
  { stdio: "inherit" }
);
