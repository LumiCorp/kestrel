export const BROWSER_RUNTIME_RELEASE_MANIFEST_VERSION =
  "browser_runtime_release_manifest_v1" as const;

export const BROWSER_RUNTIME_RELEASE_MANIFEST = Object.freeze({
  version: BROWSER_RUNTIME_RELEASE_MANIFEST_VERSION,
  engine: {
    name: "agent-browser",
    revision: "v0.35.0",
  },
  chrome: {
    name: "chrome-for-testing",
    revision: "152.0.7977.54",
  },
  targets: Object.freeze({
    "darwin-arm64": Object.freeze({
      engine: Object.freeze({
        url: "https://github.com/vercel-labs/agent-browser/releases/download/v0.35.0/agent-browser-darwin-arm64",
        sha256:
          "83ee82aa60bf60d21a4ce459bcb3aa7bc31c33a08f13f0db01d9098552e2ae39",
      }),
      chrome: Object.freeze({
        url: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.54/mac-arm64/chrome-mac-arm64.zip",
        sha256:
          "0c8741d580076b3a8add518ddbb674183992d005cdee37a4875948c9f2748d2a",
      }),
    }),
    "linux-x64": Object.freeze({
      engine: Object.freeze({
        url: "https://github.com/vercel-labs/agent-browser/releases/download/v0.35.0/agent-browser-linux-x64",
        sha256:
          "b7a28c3a43a7008dd02585e2e60c391c08983f7a099149caed63c9f13f57b752",
      }),
      chrome: Object.freeze({
        url: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.54/linux64/chrome-linux64.zip",
        sha256:
          "88af83664e1e5f79dc1c1378d0699b98dddd69690a748addf4ccbe322bfacedf",
      }),
    }),
  }),
});

export type BrowserRuntimeTarget =
  keyof typeof BROWSER_RUNTIME_RELEASE_MANIFEST.targets;

export function getBrowserRuntimeRelease(target: BrowserRuntimeTarget) {
  return BROWSER_RUNTIME_RELEASE_MANIFEST.targets[target];
}
