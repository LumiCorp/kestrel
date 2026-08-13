export const RUNTIME_HERMETIC_LANE_IDS = Object.freeze([
  "runtime-core",
  "cli-command-mode",
  "local-core-store",
  "eval-replay",
  "provider-tool-contracts",
]);
export const RUNTIME_HERMETIC_ISOLATION = "shared-process";
export const RUNTIME_HERMETIC_WORKERS = 4;

export function validateRuntimeHermeticLaneManifest(manifest, discoveredFiles) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("runtime hermetic lane manifest must be an object");
  }
  if (manifest.version !== 2) {
    throw new Error(
      `runtime hermetic lane manifest version must be 2; received ${String(manifest.version)}`,
    );
  }
  if (
    !manifest.lanes ||
    typeof manifest.lanes !== "object" ||
    Array.isArray(manifest.lanes)
  ) {
    throw new Error("runtime hermetic lane manifest must define lanes");
  }

  const expectedLanes = new Set(RUNTIME_HERMETIC_LANE_IDS);
  const actualLanes = Object.keys(manifest.lanes);
  const unknownLanes = actualLanes.filter((lane) => !expectedLanes.has(lane));
  const missingLanes = RUNTIME_HERMETIC_LANE_IDS.filter(
    (lane) => !Object.hasOwn(manifest.lanes, lane),
  );
  if (unknownLanes.length > 0) {
    throw new Error(
      `runtime hermetic lane manifest has unknown lane(s): ${unknownLanes.sort().join(", ")}`,
    );
  }
  if (missingLanes.length > 0) {
    throw new Error(
      `runtime hermetic lane manifest is missing lane(s): ${missingLanes.join(", ")}`,
    );
  }

  const assignments = new Map();
  const duplicates = new Set();
  const validatedLanes = {};
  for (const lane of RUNTIME_HERMETIC_LANE_IDS) {
    const definition = manifest.lanes[lane];
    if (
      !definition ||
      typeof definition !== "object" ||
      Array.isArray(definition)
    ) {
      throw new Error(`runtime hermetic lane '${lane}' must be an object`);
    }
    if (definition.isolation !== RUNTIME_HERMETIC_ISOLATION) {
      throw new Error(
        `runtime hermetic lane '${lane}' isolation must be '${RUNTIME_HERMETIC_ISOLATION}'`,
      );
    }
    if (definition.workers !== RUNTIME_HERMETIC_WORKERS) {
      throw new Error(
        `runtime hermetic lane '${lane}' workers must be ${RUNTIME_HERMETIC_WORKERS}`,
      );
    }
    const files = definition.files;
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error(`runtime hermetic lane '${lane}' must not be empty`);
    }
    for (const file of files) {
      if (typeof file !== "string" || file.length === 0) {
        throw new Error(
          `runtime hermetic lane '${lane}' contains an invalid file entry`,
        );
      }
      if (assignments.has(file)) duplicates.add(file);
      else assignments.set(file, lane);
    }
    validatedLanes[lane] = {
      isolation: definition.isolation,
      workers: definition.workers,
      files: [...files].sort(),
    };
  }
  if (duplicates.size > 0) {
    throw new Error(
      `runtime hermetic lane manifest assigns file(s) more than once: ${[...duplicates].sort().join(", ")}`,
    );
  }

  const discovered = new Set(discoveredFiles);
  const stale = [...assignments.keys()].filter((file) => !discovered.has(file));
  const missing = [...discovered].filter((file) => !assignments.has(file));
  if (stale.length > 0) {
    throw new Error(
      `runtime hermetic lane manifest references missing or non-hermetic file(s): ${stale.sort().join(", ")}`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `runtime hermetic lane manifest has unassigned root hermetic file(s): ${missing.sort().join(", ")}`,
    );
  }

  return validatedLanes;
}
