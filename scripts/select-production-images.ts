import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { z } from "zod";
import {
  flyImageCatalogSchema,
  impactedFlyImages,
} from "./production-image-contract.js";

const channelSchema = z.enum(["fly", "runpod"]);

async function main() {
  const channel = channelSchema.parse(process.argv[2]);
  const catalog = flyImageCatalogSchema.parse(
    JSON.parse(await readFile("deploy/fly/image-catalog.json", "utf8")),
  );
  const head = process.env.GITHUB_SHA?.trim() || "HEAD";
  const base =
    process.env.KESTREL_DIFF_BASE?.trim() ||
    execFileSync("git", ["rev-parse", `${head}^`], { encoding: "utf8" }).trim();
  const changedPaths = execFileSync(
    "git",
    ["diff", "--name-only", base, head, "--"],
    { encoding: "utf8" },
  )
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  const images = impactedFlyImages({
    catalog,
    changedPaths,
  }).filter((image) =>
    channel === "runpod"
      ? image.channel === "runpod"
      : image.channel !== "runpod",
  );
  const matrix = JSON.stringify({ role: images.map((image) => image.role) });
  const selectedRoles = JSON.stringify(images.map((image) => image.role));
  const runtimeSelected = images.some(
    (image) => image.channel === "environment-runtime",
  );
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    await appendFile(
      output,
      `matrix=${matrix}\nselected_roles=${selectedRoles}\nruntime_selected=${runtimeSelected}\n`,
      "utf8",
    );
  }
  process.stdout.write(`${matrix}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Image selection failed."}\n`,
  );
  process.exit(1);
});
