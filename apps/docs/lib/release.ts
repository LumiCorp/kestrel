export const DOCS_RELEASE = {
  packages: {
    version: "0.7.0",
    line: "0.7",
    channel: "Stable",
    releasedPackageNames: [
      "@kestrel-agents/kestrel",
      "@kestrel-agents/protocol",
      "@kestrel-agents/sdk",
      "@kestrel-agents/memory",
      "@kestrel-agents/next",
      "@kestrel-agents/ai-sdk",
      "@kestrel-agents/observability",
      "@kestrel-agents/workspace-skills",
    ],
    releaseNotesUrl: "/reference/releases",
  },
  products: {
    desktop: {
      version: "0.7.0",
      channel: "Stable",
      mode: "release-gated",
      releasesUrl: "https://github.com/LumiCorp/kestrel/releases/tag/desktop-v0.7.0",
      downloadUrl: "https://github.com/LumiCorp/kestrel/releases/download/desktop-v0.7.0/Kestrel-0.7.0-mac-arm64.dmg",
      artifactStatus: "published",
      supportedPlatforms: ["macOS"],
      trustNote: "Download the signed and notarized DMG for macOS 13 or later on Apple silicon.",
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
    { surface: "Memory", version: "0.7.0", channel: "Stable", note: "Provides governed memory contracts and retrieval helpers" },
    { surface: "Next.js", version: "0.7.0", channel: "Stable", note: "Adapts SDK results to server routes" },
    { surface: "AI SDK", version: "0.7.0", channel: "Stable", note: "Adapts runner streams to AI SDK presentation events" },
    { surface: "Observability", version: "0.7.0", channel: "Stable", note: "Wraps compatible SDK operations" },
    { surface: "Workspace skills", version: "0.7.0", channel: "Stable", note: "Installs and verifies portable workspace guidance" },
    { surface: "CLI", version: "0.7.0", channel: "Stable", note: "Operates the matching runtime line" },
    { surface: "Desktop", version: "0.7.0", channel: "Stable", note: "Signed and notarized macOS arm64 application" },
    { surface: "Kestrel One", version: "Managed", channel: "Invitation", note: "Consumes an invitation-managed package set" },
  ],
} as const;

export const DOCS_RELEASE_LABEL = `${DOCS_RELEASE.packages.version} ${DOCS_RELEASE.packages.channel}`;
