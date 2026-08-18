import {
  normalizeToolActionInput,
  sanitizeToolInputForSchema,
} from "./normalizeToolInput.js";

const LEGACY_ALIASES: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  "evidence.extract": {
    text: ["content"],
    sourceId: ["source"],
    maxItems: ["limit"],
  },
  "fs.list": { path: ["filePath", "targetPath"] },
  "fs.read_text": { path: ["filePath", "targetPath"] },
  "fs.read_text_page": { path: ["filePath", "targetPath"] },
  "fs.verify_json": { path: ["filePath", "targetPath"] },
  "fs.search_text": {
    path: ["filePath", "targetPath"],
    query: ["pattern"],
  },
  "repo.trace": { path: ["filePath", "targetPath"] },
  "fs.write_text": {
    path: ["filePath", "targetPath"],
    content: ["text"],
  },
  "fs.replace_text": { path: ["filePath", "targetPath"] },
  "fs.mkdir": { path: ["filePath", "targetPath"] },
  "fs.delete": { path: ["filePath", "targetPath"] },
  "fs.copy": { sourcePath: ["from"], destinationPath: ["to"] },
  "fs.move": { sourcePath: ["from"], destinationPath: ["to"] },
};

/**
 * Adapts input from a trusted legacy caller before it reaches the strict tool
 * gateway. Model-generated tool input must never use this compatibility path.
 */
export function adaptTrustedLegacyToolInput(input: {
  name: string;
  value: Record<string, unknown>;
  schema: Record<string, unknown>;
  workspaceRoot?: string | undefined;
}): unknown {
  const adapted = { ...input.value };
  for (const [canonical, aliases] of Object.entries(
    LEGACY_ALIASES[input.name] ?? {},
  )) {
    if (adapted[canonical] !== undefined) continue;
    const alias = aliases.find((candidate) => adapted[candidate] !== undefined);
    if (alias !== undefined) adapted[canonical] = adapted[alias];
  }
  return sanitizeToolInputForSchema(
    input.schema,
    normalizeToolActionInput(input.name, adapted, input.workspaceRoot),
  );
}
