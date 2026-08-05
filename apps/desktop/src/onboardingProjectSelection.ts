import type { DesktopProjectRegistration } from "./contracts.js";

export function findExactRegisteredOnboardingProject(
  projects: DesktopProjectRegistration[],
  requestedPath: unknown,
): DesktopProjectRegistration | undefined {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    return undefined;
  }
  return projects.find((project) => project.path === requestedPath);
}
