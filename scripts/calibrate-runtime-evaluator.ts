import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ProfileStore } from "../cli/config/ProfileStore.js";
import {
  createModelGatewayForProfile,
  createRuntimeEvaluationJudgeInvoker,
} from "../cli/runtime/KestrelChatRuntime.js";
import {
  parseRuntimeEvaluationPolicyV1,
} from "../src/kestrel/contracts/evaluation.js";
import {
  createDefaultRuntimeEvaluatorRegistry,
  runRuntimeEvaluationCalibrationV1,
} from "../src/evaluation/index.js";

async function main(): Promise<void> {
  const profileId = requiredFlag("--profile");
  const outputPath = path.resolve(requiredFlag("--out"));
  const profileStore = new ProfileStore();
  const profiles = await profileStore.load();
  const profile = profiles.find((entry) => entry.id === profileId);
  if (profile === undefined) {
    throw new Error(`Runtime evaluation calibration profile '${profileId}' was not found.`);
  }
  if (profile.evaluationPolicy === undefined) {
    throw new Error(
      `Profile '${profileId}' does not define an opt-in runtime evaluation policy.`,
    );
  }
  const policy = parseRuntimeEvaluationPolicyV1(profile.evaluationPolicy);
  const gateway = createModelGatewayForProfile(profile, { env: process.env });
  const record = await runRuntimeEvaluationCalibrationV1({
    policy,
    evaluatorRegistry: createDefaultRuntimeEvaluatorRegistry(),
    invokeJudge: createRuntimeEvaluationJudgeInvoker(policy, gateway),
  });
  if (record.passed !== true) {
    throw new Error(
      `Runtime evaluator calibration failed: ${JSON.stringify(record.metrics)}.`,
    );
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      recordId: record.recordId,
      recordRevision: record.revision,
      observedModelRevision: record.observedModelRevision,
      outputPath,
      nextStep:
        "Pin evaluationPolicy.calibration.recordRevision to recordRevision and set KCHAT_RUNTIME_EVALUATION_CALIBRATION_PATH to outputPath.",
    })}\n`,
  );
}

function requiredFlag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1]?.trim();
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(
      "Usage: pnpm calibrate:runtime-evaluator -- --profile <profile-id> --out <record.json>",
    );
  }
  return value;
}

await main();
