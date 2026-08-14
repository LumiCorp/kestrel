import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { flyImageReleaseManifestV3Schema } from "../apps/web/lib/releases/contracts.js";
import { runStreamingCommand } from "./lib/streaming-command.js";

const manifestPath = process.argv[2];
if (!manifestPath) {
  throw new Error("usage: pnpm release:smoke-manifest MANIFEST.json");
}

const manifest = flyImageReleaseManifestV3Schema.parse(
  JSON.parse(await readFile(resolve(manifestPath), "utf8")),
);
const componentSmokeByRole = {
  "workspace-runtime": "apps/workspace-runtime/scripts/image-smoke.sh",
  "environment-router": "apps/environment-router/scripts/image-smoke.sh",
  "preview-edge": "apps/preview-edge/scripts/image-smoke.sh",
  "turn-worker": "deploy/fly/kestrel-one-turn-worker/smoke.sh",
  "runpod-worker": "deploy/fly/kestrel-one-runpod-worker/smoke.sh",
} as const;
const smokes = [
  {
    role: manifest.controller.role,
    script: "deploy/fly/kestrel-one-control-worker/smoke.sh",
    image: manifest.controller.image,
    environment: {
      EXPECTED_CONTROL_WORKER_FINGERPRINT:
        manifest.controller.inputFingerprint.replace(/^sha256:/u, ""),
    },
  },
  ...manifest.components.map((component) => ({
    role: component.role,
    script: componentSmokeByRole[component.role],
    image: component.image,
    environment: {},
  })),
];
const results = await Promise.allSettled(
  smokes.map(async (smoke) => {
    await runStreamingCommand("bash", [smoke.script, smoke.image], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...smoke.environment,
        EXPECTED_GIT_SHA: manifest.bundleRevision,
      },
    });
    return smoke.role;
  }),
);
const failures = results.flatMap((result, index) =>
  result.status === "rejected"
    ? [
        {
          role: smokes[index]!.role,
          message:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        },
      ]
    : [],
);
if (failures.length) {
  throw new Error(
    `Release manifest image smokes failed:\n${failures
      .map((failure) => `- ${failure.role}: ${failure.message}`)
      .join("\n")}`,
  );
}
process.stdout.write(
  `All six immutable images passed for ${manifest.bundleRevision}.\n`,
);
