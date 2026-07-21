import path from "node:path";

export interface DesktopPackagerConfig {
  appName: string;
  arch: string;
  executableName: string;
  iconPath: string;
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
  const platform = input.platform ?? process.platform;
  return {
    appName: "Kestrel",
    arch: input.arch ?? process.arch,
    executableName: "Kestrel",
    iconPath: path.join(desktopDir, "assets", `kestrel-head.${resolveIconExtension(platform)}`),
    outDir: path.join(desktopDir, "out"),
    platform,
    stageDir: path.join(desktopDir, ".desktop-package"),
  };
}

function resolveIconExtension(platform: string): "icns" | "ico" | "png" {
  if (platform === "darwin") {
    return "icns";
  }
  if (platform === "win32") {
    return "ico";
  }
  return "png";
}
