export const PROCESS_MODULE_MANIFEST_VERSION = 1;

export function validateProcessModuleManifest(manifest, discoveredFiles) {
  if (manifest?.version !== PROCESS_MODULE_MANIFEST_VERSION) {
    throw new Error(
      `process module manifest must use version ${PROCESS_MODULE_MANIFEST_VERSION}`,
    );
  }
  if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) {
    throw new Error("process module manifest must declare at least one module");
  }

  const ids = new Set();
  const prefixes = new Set();
  for (const module of manifest.modules) {
    if (!module || typeof module.id !== "string" || module.id.length === 0) {
      throw new Error("process module manifest contains a module without an id");
    }
    if (ids.has(module.id)) {
      throw new Error(`process module manifest duplicates '${module.id}'`);
    }
    ids.add(module.id);
    if (!Array.isArray(module.prefixes) || module.prefixes.length === 0) {
      throw new Error(`process module '${module.id}' must declare prefixes`);
    }
    for (const prefix of module.prefixes) {
      if (typeof prefix !== "string" || prefix.length === 0) {
        throw new Error(`process module '${module.id}' contains an empty prefix`);
      }
      if (prefixes.has(prefix)) {
        throw new Error(`process module manifest duplicates prefix '${prefix}'`);
      }
      prefixes.add(prefix);
    }
  }

  const assignments = new Map();
  for (const file of discoveredFiles) {
    const matches = manifest.modules.filter((module) =>
      module.prefixes.some((prefix) => file.startsWith(prefix)),
    );
    if (matches.length !== 1) {
      const owners = matches.map((module) => module.id).join(", ");
      throw new Error(
        `process test '${file}' must belong to exactly one module; found ${
          matches.length
        }${owners ? ` (${owners})` : ""}`,
      );
    }
    assignments.set(file, matches[0].id);
  }
  return assignments;
}

export function processModuleIds(manifest) {
  return manifest.modules.map((module) => module.id);
}
