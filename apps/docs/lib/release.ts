export const DOCS_RELEASE = {
  packages: {
    version: "0.7.0",
    line: "0.7",
    channel: "Stable",
    releasedPackageNames: [
      "@kestrel-agents/kestrel",
      "@kestrel-agents/protocol",
      "@kestrel-agents/sdk",
      "@kestrel-agents/next",
      "@kestrel-agents/ai-sdk",
      "@kestrel-agents/observability",
      "@kestrel-agents/workspace-skills",
    ],
    releaseNotesUrl: "/reference/releases",
  },
  products: {
    desktop: {
      version: "0.6.0",
      channel: "Stable",
      mode: "release-gated",
      releasesUrl: "https://github.com/LumiCorp/kestrel/releases/tag/v0.6.0",
      downloadUrl: "https://github.com/LumiCorp/kestrel/releases/download/v0.6.0/Kestrel-0.6.0-darwin-arm64.zip",
      artifactStatus: "published",
      supportedPlatforms: ["macOS"],
      trustNote: "Download the macOS arm64 archive from the v0.6.0 release and review its release notes before opening the application.",
    },
    kestrelOne: {
      version: "Managed",
      channel: "Invitation",
      mode: "invitation",
      accessNote: "Kestrel One is available to invited teams. Use the invitation from your organization administrator to sign in.",
    },
  },
  compatibility: [
    { surface: "Runtime", version: "0.7.0", channel: "Stable", note: "Owns execution and the runner service" },
    { surface: "Protocol", version: "0.7.0", channel: "Stable", note: "Owns terminal parsing, including assistantText" },
    { surface: "SDK", version: "0.7.0", channel: "Stable", note: "Consumes the public runner contract" },
    { surface: "Next.js", version: "0.7.0", channel: "Stable", note: "Adapts SDK results to server routes" },
    { surface: "AI SDK", version: "0.7.0", channel: "Stable", note: "Adapts runner streams to AI SDK presentation events" },
    { surface: "Observability", version: "0.7.0", channel: "Stable", note: "Wraps compatible SDK operations" },
    { surface: "Workspace skills", version: "0.7.0", channel: "Stable", note: "Installs and verifies portable workspace guidance" },
    { surface: "CLI", version: "0.7.0", channel: "Stable", note: "Operates the matching runtime line" },
    { surface: "Desktop", version: "0.6.0", channel: "Stable", note: "Remains on the signed public Desktop release" },
    { surface: "Kestrel One", version: "Managed", channel: "Invitation", note: "Consumes an invitation-managed package set" },
  ],
} as const;

export const DOCS_RELEASE_LABEL = `${DOCS_RELEASE.packages.version} ${DOCS_RELEASE.packages.channel}`;
