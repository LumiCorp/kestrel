export const FILE_TEXT_READ_TOOL_NAMES = [
  "fs.read_text",
  "fs.read_text_page",
] as const;

export type FileTextReadToolName = (typeof FILE_TEXT_READ_TOOL_NAMES)[number];

export function isFileTextReadToolName(name: string): name is FileTextReadToolName {
  return FILE_TEXT_READ_TOOL_NAMES.includes(name as FileTextReadToolName);
}
