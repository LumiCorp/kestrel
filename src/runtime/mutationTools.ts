export const MUTATION_CAPABLE_TOOL_NAMES = new Set([
  "fs.create_text",
  "fs.edit_text",
  "fs.apply_patch",
  "fs.write_text",
  "fs.replace_text",
  "fs.copy",
  "fs.move",
  "fs.delete",
  "fs.mkdir",
  "code.execute",
  "exec_command",
  "dev.shell.run",
  "dev.process.start",
  "dev.process.write",
  "dev.process.write_and_read",
  "dev.process.stop",
]);

export function isMutationCapableToolName(name: string): boolean {
  return MUTATION_CAPABLE_TOOL_NAMES.has(name);
}
