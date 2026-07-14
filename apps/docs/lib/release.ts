export const DOCS_RELEASE = {
  version: "0.6.0-beta.0",
  line: "0.6",
  channel: "Beta",
  releasedPackageNames: [
    "@kestrel-agents/kestrel",
    "@kestrel-agents/protocol",
    "@kestrel-agents/sdk",
    "@kestrel-agents/next",
    "@kestrel-agents/observability",
  ],
  releaseNotesUrl: "/reference/releases",
  productAccess: {
    desktop: {
      mode: "release-gated",
      releasesUrl: "https://github.com/LumiCorp/kestrel/releases",
      artifactStatus: "not-yet-published",
      supportedPlatforms: ["macOS"],
      trustNote: "The 0.6.0 Beta artifact has not been published yet. Do not install an older Desktop build with these 0.6 docs.",
    },
    kestrelOne: {
      mode: "invitation",
      accessNote: "Kestrel One is available to invited Beta teams. Use the invitation from your organization administrator to sign in.",
    },
  },
  compatibility: [
    ["Runtime", "Owns execution and the runner service"],
    ["Protocol", "Owns terminal parsing, including assistantText"],
    ["SDK", "Consumes the public runner contract"],
    ["Next.js", "Adapts SDK results to server routes"],
    ["Observability", "Wraps compatible SDK operations"],
    ["CLI", "Operates the matching runtime line"],
    ["Desktop", "Bundles compatible Local Core resources"],
    ["Kestrel One", "Consumes exact released public packages"],
  ],
} as const;

export const DOCS_RELEASE_LABEL = `${DOCS_RELEASE.version} ${DOCS_RELEASE.channel}`;
