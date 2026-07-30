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
  otaFixture?: DesktopOtaFixtureBuildInput | undefined;
}

export interface DesktopOtaFixtureBuildInput {
  approved: boolean;
  updateUrl: string;
  outputDirectory: string;
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
    icon: string;
    identity: string | null;
    target: Array<{ target: "dir" | "dmg" | "zip"; arch: ["arm64"] }>;
  };
  publish: {
    provider: "generic";
    channel: "latest";
    url: string;
    useMultipleRangeRequest?: false | undefined;
  };
  afterSign?: string | undefined;
}

export const DESKTOP_UPDATE_ORIGIN = "https://updates.lumicorp.ai";
export const DESKTOP_OTA_FIXTURE_UPDATE_URL =
  "https://localhost:45173/desktop/stable/arm64";
export const DESKTOP_OTA_FIXTURE_VERSIONS = [
  "0.7.0-ota.1",
  "0.7.0-ota.2",
  "0.7.0-ota.3",
] as const;

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
  const electronBuilderSigningIdentity = signingIdentity === undefined
    ? undefined
    : resolveElectronBuilderSigningIdentity(signingIdentity);
  const desktopRoot = path.join(input.repoRoot, "apps", "desktop");
  const otaFixture = input.otaFixture === undefined
    ? undefined
    : validateDesktopOtaFixtureBuild({
        ...input.otaFixture,
        desktopRoot,
        releaseBuild: input.releaseBuild,
        packageMode,
        version: input.version,
      });
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

  const config: DesktopBuilderConfiguration = {
    appId: "com.kestrel.desktop",
    productName: "Kestrel",
    electronVersion: input.electronVersion,
    artifactName: `Kestrel-${input.version}-mac-\${arch}.\${ext}`,
    asar: false,
    npmRebuild: false,
    directories: {
      app: path.join(desktopRoot, ".desktop-package"),
      output: otaFixture?.outputDirectory ?? path.join(desktopRoot, "out"),
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
        from: path.join(desktopRoot, "assets", "kestrel-app-icon-light.png"),
        to: "kestrel-app-icon-light.png",
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
      icon: path.join(desktopRoot, "assets", "kestrel-app-icon-light.icns"),
      identity: input.releaseBuild ? electronBuilderSigningIdentity! : null,
      target: packageMode === "dir"
        ? [{ target: "dir", arch: ["arm64"] }]
        : [
            { target: "dmg", arch: ["arm64"] },
            { target: "zip", arch: ["arm64"] },
          ],
    },
    publish: {
      provider: "generic",
      channel: "latest",
      url: otaFixture?.updateUrl ?? resolveDesktopUpdateUrl(channel),
      ...(otaFixture === undefined
        ? {}
        : { useMultipleRangeRequest: false as const }),
    },
  };
  if (input.releaseBuild) {
    config.afterSign = path.join(input.repoRoot, "scripts", "notarize-desktop.mjs");
  }
  return config;
}

function resolveElectronBuilderSigningIdentity(identity: string): string {
  const match = /^Developer ID Application:\s+(.+)$/u.exec(identity);
  if (match?.[1]?.trim() === undefined || match[1].trim().length === 0) {
    throw new Error(
      "KESTREL_DESKTOP_SIGN_IDENTITY must name a full Developer ID Application authority.",
    );
  }
  return match[1].trim();
}

function validateDesktopOtaFixtureBuild(
  input: DesktopOtaFixtureBuildInput & {
    desktopRoot: string;
    releaseBuild: boolean;
    packageMode: "dir" | "release";
    version: string;
  },
): { updateUrl: string; outputDirectory: string } {
  if (!input.approved) {
    throw new Error(
      "Desktop OTA fixture packaging requires KESTREL_DESKTOP_OTA_FIXTURE_BUILD_APPROVED=1.",
    );
  }
  if (!input.releaseBuild || input.packageMode !== "release") {
    throw new Error(
      "Desktop OTA fixtures must use the signed release packaging path.",
    );
  }
  if (
    !DESKTOP_OTA_FIXTURE_VERSIONS.includes(
      input.version as (typeof DESKTOP_OTA_FIXTURE_VERSIONS)[number],
    )
  ) {
    throw new Error(
      `Desktop OTA fixture version must be one of ${DESKTOP_OTA_FIXTURE_VERSIONS.join(", ")}.`,
    );
  }
  if (input.updateUrl !== DESKTOP_OTA_FIXTURE_UPDATE_URL) {
    throw new Error(
      `Desktop OTA fixtures must use ${DESKTOP_OTA_FIXTURE_UPDATE_URL}.`,
    );
  }
  const updateUrl = new URL(input.updateUrl);
  if (
    updateUrl.protocol !== "https:" ||
    updateUrl.hostname !== "localhost" ||
    updateUrl.port !== "45173" ||
    updateUrl.username !== "" ||
    updateUrl.password !== "" ||
    updateUrl.search !== "" ||
    updateUrl.hash !== ""
  ) {
    throw new Error("Desktop OTA fixture update URL must be exact loopback HTTPS.");
  }
  const outputDirectory = path.resolve(input.outputDirectory);
  const expectedOutputDirectory = path.resolve(
    input.desktopRoot,
    "out",
    "ota-fixtures",
    input.version,
  );
  if (outputDirectory !== expectedOutputDirectory) {
    throw new Error(
      `Desktop OTA fixture output must be ${expectedOutputDirectory}.`,
    );
  }
  return {
    updateUrl: input.updateUrl,
    outputDirectory,
  };
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
