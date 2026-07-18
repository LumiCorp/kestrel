import { relative, resolve, sep } from "node:path";

export function resolveWorkspaceTarget(workspaceRoot: string, target: string): string {
  return resolve(resolve(workspaceRoot), target);
}

export function renderWorkspaceRelativeTarget(
  workspaceRoot: string,
  target: string,
): string {
  const resolvedRoot = resolve(workspaceRoot);
  const rendered = relative(resolvedRoot, resolveWorkspaceTarget(resolvedRoot, target));
  if (rendered === ".." || rendered.startsWith(`..${sep}`)) {
    return "<outside-active-workspace>";
  }
  return rendered.length === 0 ? "." : rendered;
}
