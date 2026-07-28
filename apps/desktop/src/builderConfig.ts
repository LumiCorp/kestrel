import path from "node:path";

export type DesktopUpdateChannel = "stable" | "candidate";

export interface DesktopBuilderConfigInput {
  repoRoot: string;
  version: string;
  electronVersion: string;
  releaseBuild: boolean;
  updateChannel?: DesktopUpdateChannel | undefined;
  signingIdentity?: string | undefined;
  packageMode?: "dir" | "release" | undefined;
}

export interface DesktopBuilderConfiguration {
  appId: string;
  productName: string;
  electronVersion: string;
  artifactName: string;
  asar: false;
  npmRebuild: false;
  directories: {
    app: string;
    output: string;
    buildResources: string;
  };
  files: string[];
  extraResources: Array<{
    from: string;
    to: string;
    filter?: string[] | undefined;
  }>;
  mac: {
    category: string;
    hardenedRuntime: boolean;
    gatekeeperAssess: false;
    identity: string | null;
    target: Array<{ target: "dir" | "dmg" | "zip"; arch: ["arm64"] }>;
  };
  publish: {
    provider: "generic";
    url: string;
  };
  afterSign?: string | undefined;
}

export const DESKTOP_UPDATE_ORIGIN = "https://updates.lumicorp.ai";

export function resolveDesktopUpdateUrl(
  channel: DesktopUpdateChannel,
): string {
  return `${DESKTOP_UPDATE_ORIGIN}/desktop/${channel}/arm64`;
}

export function resolveDesktopBuilderConfiguration(
  input: DesktopBuilderConfigInput,
): DesktopBuilderConfiguration {
  const channel = input.updateChannel ?? "stable";
  const packageMode = input.packageMode ?? "release";
  const signingIdentity = input.signingIdentity?.trim();
  if (packageMode === "release" && (!input.releaseBuild || !signingIdentity)) {
    throw new Error(
      "Desktop release packaging requires KESTREL_DESKTOP_RELEASE=1 and KESTREL_DESKTOP_SIGN_IDENTITY naming a Developer ID Application certificate.",
    );
  }
  if (packageMode === "dir" && input.releaseBuild) {
    throw new Error("The unsigned Desktop dir gate cannot enable release signing.");
  }
  if (input.releaseBuild && channel !== "stable") {
    throw new Error(
      "Final Desktop release artifacts must use the stable update channel.",
    );
  }

  const desktopRoot = path.join(input.repoRoot, "apps", "desktop");
  const config: DesktopBuilderConfiguration = {
    appId: "com.kestrel.desktop",
    productName: "Kestrel",
    electronVersion: input.electronVersion,
    artifactName: `Kestrel-${input.version}-mac-\${arch}.\${ext}`,
    asar: false,
    npmRebuild: false,
    directories: {
      app: path.join(desktopRoot, ".desktop-package"),
      output: path.join(desktopRoot, "out"),
      buildResources: path.join(desktopRoot, "assets"),
    },
    files: ["**/*", "!node_modules{,/**/*}"],
    extraResources: [
      {
        from: path.join(desktopRoot, ".desktop-package", "node_modules"),
        to: path.join("app", "node_modules"),
        filter: ["**/*"],
      },
      {
        from: path.join(desktopRoot, ".desktop-runtime"),
        to: "kestrel-runtime",
        filter: ["**/*", "!node_modules{,/**/*}"],
      },
      {
        from: path.join(desktopRoot, ".desktop-runtime", "node_modules"),
        to: path.join("kestrel-runtime", "node_modules"),
        filter: ["**/*"],
      },
      {
        from: path.join(desktopRoot, "static"),
        to: "static",
      },
      {
        from: path.join(desktopRoot, "assets", "kestrel-head.png"),
        to: path.join("assets", "kestrel-head.png"),
      },
      {
        from: path.join(desktopRoot, "resources", "kestrel-uninstall-helper"),
        to: "kestrel-uninstall-helper",
      },
    ],
    mac: {
      category: "public.app-category.developer-tools",
      hardenedRuntime: input.releaseBuild,
      gatekeeperAssess: false,
      identity: input.releaseBuild ? signingIdentity! : null,
      target: packageMode === "dir"
        ? [{ target: "dir", arch: ["arm64"] }]
        : [
            { target: "dmg", arch: ["arm64"] },
            { target: "zip", arch: ["arm64"] },
          ],
    },
    publish: {
      provider: "generic",
      url: resolveDesktopUpdateUrl(channel),
    },
  };
  if (input.releaseBuild) {
    config.afterSign = path.join(input.repoRoot, "scripts", "notarize-desktop.mjs");
  }
  return config;
}

export function parseDesktopUpdateChannel(
  value: string | undefined,
): DesktopUpdateChannel {
  const normalized = value?.trim() || "stable";
  if (normalized !== "stable" && normalized !== "candidate") {
    throw new Error(
      `KESTREL_DESKTOP_UPDATE_CHANNEL must be stable or candidate; received '${normalized}'.`,
    );
  }
  return normalized;
}
