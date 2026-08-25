export const PROCESS_MODULE_MANIFEST_VERSION: 1;

export interface ProcessModuleDefinition {
  id: string;
  description: string;
  prefixes: string[];
}

export interface ProcessModuleManifest {
  version: 1;
  modules: ProcessModuleDefinition[];
}

export function validateProcessModuleManifest(
  manifest: ProcessModuleManifest,
  discoveredFiles: string[],
): Map<string, string>;

export function processModuleIds(
  manifest: ProcessModuleManifest,
): string[];
