import path from "node:path";

import {
  isDesktopPersonalAppId,
  normalizeDesktopAppId,
} from "../../../src/desktopShell/configuration.js";
import type { DesktopExecutionSelection } from "../../../src/desktopShell/configuration.js";
import type { DesktopProjectRegistration } from "../../../src/desktopShell/contracts.js";

/**
 * Returns enabled App IDs that may execute for one Desktop Project. Built-in
 * Apps retain their existing global behavior. Personal Apps require all three
 * authorities: the Project's saved selection, the renderer's request, and the
 * current enabled connection set.
 */
export function resolveProjectScopedDesktopAppIds(input: {
  projectPath?: string | undefined;
  projects: readonly DesktopProjectRegistration[];
  requested: DesktopExecutionSelection;
  enabledAppIds: readonly string[];
}): string[] {
  const canonicalProjectPath =
    input.projectPath === undefined ? undefined : path.resolve(input.projectPath);
  const requested = new Set(
    input.requested.apps.map((app) => normalizeDesktopAppId(app.id)),
  );
  const selectedPersonalAppIds = new Set(
    canonicalProjectPath === undefined
      ? []
      : input.projects.find(
          (project) => path.resolve(project.path) === canonicalProjectPath,
        )?.personalAppIds ?? [],
  );

  return input.enabledAppIds.filter((appId) => {
    const normalizedAppId = normalizeDesktopAppId(appId);
    return (
      !isDesktopPersonalAppId(normalizedAppId) ||
      (requested.has(normalizedAppId) && selectedPersonalAppIds.has(normalizedAppId))
    );
  });
}
