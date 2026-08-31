export const BROWSER_RUNTIME_RELEASE_MANIFEST_VERSION =
  "browser_runtime_release_manifest_v2" as const;

export const DESKTOP_BROWSER_RUNTIME_TARGET = "darwin-arm64" as const;
export const DESKTOP_BROWSER_RUNTIME_RESOURCE_DIRECTORY =
  "browser-runtime" as const;
export const HOSTED_BROWSER_WORKER_IMAGE_REPOSITORY =
  "registry.fly.io/kestrel-one-browser-worker" as const;

export const BROWSER_RUNTIME_RELEASE_MANIFEST = Object.freeze({
  version: BROWSER_RUNTIME_RELEASE_MANIFEST_VERSION,
  engine: {
    name: "agent-browser",
    revision: "v0.35.0-kestrel.1",
    upstreamRevision: "585e740fcef069d74e21f0e88e8bf4ea7df34385",
  },
  chrome: {
    name: "chrome-for-testing",
    revision: "152.0.7977.54",
  },
  targets: Object.freeze({
    "darwin-arm64": Object.freeze({
      engine: Object.freeze({
        source: Object.freeze({
          kind: "repository" as const,
          relativePath:
            "third_party/agent-browser/v0.35.0-kestrel.1/agent-browser-darwin-arm64",
        }),
        sha256:
          "8b8bd5ca449676b819f310d3a281a1ebc2160a29fb1dbfb456298170ece96099",
        sourceFileName: "agent-browser-darwin-arm64",
        executableRelativePath: "agent-browser",
      }),
      chrome: Object.freeze({
        source: Object.freeze({
          kind: "https" as const,
          url: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.54/mac-arm64/chrome-mac-arm64.zip",
        }),
        sha256:
          "0c8741d580076b3a8add518ddbb674183992d005cdee37a4875948c9f2748d2a",
        sourceFileName: "chrome-mac-arm64.zip",
        archiveRoot: "chrome-mac-arm64",
        executableRelativePath:
          "chrome/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        excludedRuntimeRelativePaths: Object.freeze([
          "chrome/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/152.0.7977.54/Resources/install.sh",
        ]),
      }),
    }),
    "linux-x64": Object.freeze({
      engine: Object.freeze({
        source: Object.freeze({
          kind: "repository" as const,
          relativePath:
            "third_party/agent-browser/v0.35.0-kestrel.1/agent-browser-linux-x64",
        }),
        sha256:
          "5b2dbebc79f669e06c0eef6749ae3a086c1c8f3421659a90288467d999e2d881",
        sourceFileName: "agent-browser-linux-x64",
        executableRelativePath: "agent-browser",
      }),
      chrome: Object.freeze({
        source: Object.freeze({
          kind: "https" as const,
          url: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.54/linux64/chrome-linux64.zip",
        }),
        sha256:
          "88af83664e1e5f79dc1c1378d0699b98dddd69690a748addf4ccbe322bfacedf",
        sourceFileName: "chrome-linux64.zip",
        archiveRoot: "chrome-linux64",
        executableRelativePath: "chrome/chrome",
        excludedRuntimeRelativePaths: Object.freeze([]),
      }),
    }),
  }),
});

export type BrowserRuntimeTarget =
  keyof typeof BROWSER_RUNTIME_RELEASE_MANIFEST.targets;

export function getBrowserRuntimeRelease(target: BrowserRuntimeTarget) {
  return BROWSER_RUNTIME_RELEASE_MANIFEST.targets[target];
}

export function getDesktopBrowserRuntimeRelease() {
  return BROWSER_RUNTIME_RELEASE_MANIFEST.targets[DESKTOP_BROWSER_RUNTIME_TARGET];
}

export function getDesktopBrowserRuntimeExecutableRelativePaths(): {
  engineExecutablePath: string;
  chromeExecutablePath: string;
} {
  const release = getDesktopBrowserRuntimeRelease();
  return {
    engineExecutablePath:
      `${DESKTOP_BROWSER_RUNTIME_RESOURCE_DIRECTORY}/${release.engine.executableRelativePath}`,
    chromeExecutablePath:
      `${DESKTOP_BROWSER_RUNTIME_RESOURCE_DIRECTORY}/${release.chrome.executableRelativePath}`,
  };
}

export function getHostedBrowserRuntimeRelease() {
  return BROWSER_RUNTIME_RELEASE_MANIFEST.targets["linux-x64"];
}

export function requireImmutableHostedBrowserWorkerImage(value: string): string {
  const image = value.trim();
  if (
    !new RegExp(
      `^${escapeRegExp(HOSTED_BROWSER_WORKER_IMAGE_REPOSITORY)}@sha256:[a-f0-9]{64}$`,
      "u",
    ).test(image)
  ) {
    throw new Error(
      `Hosted Browser worker image must use an immutable digest from ${HOSTED_BROWSER_WORKER_IMAGE_REPOSITORY}.`,
    );
  }
  return image;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
