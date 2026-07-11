export function normalizeSubmittedLine(line: string): string {
  return line.replace(/[\r\n]+$/u, "");
}
