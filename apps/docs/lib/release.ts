export const DOCS_RELEASE = {
  version: "0.6.0",
  line: "0.6",
  channel: "Stable",
  releasedPackageNames: [
    "@kestrel-agents/kestrel",
    "@kestrel-agents/protocol",
    "@kestrel-agents/sdk",
    "@kestrel-agents/next",
    "@kestrel-agents/ai-sdk",
    "@kestrel-agents/observability",
  ],
  releaseNotesUrl: "/reference/releases",
  productAccess: {
    desktop: {
      mode: "release-gated",
      releasesUrl: "https://github.com/LumiCorp/kestrel/releases/tag/v0.6.0",
      downloadUrl: "https://github.com/LumiCorp/kestrel/releases/download/v0.6.0/Kestrel-0.6.0-darwin-arm64.zip",
      artifactStatus: "published",
      supportedPlatforms: ["macOS"],
      trustNote: "Download the macOS arm64 archive from the v0.6.0 release and review its release notes before opening the application.",
    },
    kestrelOne: {
      mode: "invitation",
      accessNote: "Kestrel One is available to invited teams. Use the invitation from your organization administrator to sign in.",
    },
  },
  compatibility: [
    ["Runtime", "Owns execution and the runner service"],
    ["Protocol", "Owns terminal parsing, including assistantText"],
    ["SDK", "Consumes the public runner contract"],
    ["Next.js", "Adapts SDK results to server routes"],
    ["AI SDK", "Adapts runner streams to AI SDK presentation events"],
    ["Observability", "Wraps compatible SDK operations"],
    ["CLI", "Operates the matching runtime line"],
    ["Desktop", "Bundles compatible Local Core resources"],
    ["Kestrel One", "Consumes exact released public packages"],
  ],
} as const;

export const DOCS_RELEASE_LABEL = `${DOCS_RELEASE.version} ${DOCS_RELEASE.channel}`;
