import path from "node:path";

export interface DesktopPackagerConfig {
  appName: string;
  arch: string;
  executableName: string;
  outDir: string;
  platform: string;
  stageDir: string;
}

export function resolveDesktopPackagerConfig(input: {
  arch?: string | undefined;
  platform?: string | undefined;
  repoRoot: string;
}): DesktopPackagerConfig {
  const desktopDir = path.join(input.repoRoot, "apps", "desktop");
  return {
    appName: "Kestrel",
    arch: input.arch ?? process.arch,
    executableName: "Kestrel",
    outDir: path.join(desktopDir, "out"),
    platform: input.platform ?? process.platform,
    stageDir: path.join(desktopDir, ".desktop-package"),
  };
}
