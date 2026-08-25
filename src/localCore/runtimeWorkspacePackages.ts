export const RUNTIME_WORKSPACE_PACKAGES = [
  {
    name: "@kestrel-agents/protocol",
    directory: "packages/protocol",
    tarballPrefix: "kestrel-agents-protocol-",
    packedRuntimeRangePrefix: "",
  },
  {
    name: "@kestrel-agents/conversation",
    directory: "packages/conversation",
    tarballPrefix: "kestrel-agents-conversation-",
    packedRuntimeRangePrefix: "",
  },
  {
    name: "@kestrel-agents/files",
    directory: "packages/attachments",
    tarballPrefix: "kestrel-agents-files-",
    packedRuntimeRangePrefix: "",
  },
  {
    name: "@kestrel-agents/sdk",
    directory: "packages/sdk",
    tarballPrefix: "kestrel-agents-sdk-",
    packedRuntimeRangePrefix: "",
  },
  {
    name: "@kestrel-agents/workspace-skills",
    directory: "packages/workspace-skills",
    tarballPrefix: "kestrel-agents-workspace-skills-",
    packedRuntimeRangePrefix: "",
  },
  {
    name: "@kestrel-agents/memory",
    directory: "packages/memory",
    tarballPrefix: "kestrel-agents-memory-",
    packedRuntimeRangePrefix: "",
  },
  {
    name: "@lumi/kestrel-environment-auth",
    directory: "packages/environment-auth",
    tarballPrefix: "lumi-kestrel-environment-auth-",
    packedRuntimeRangePrefix: "^",
  },
] as const;

export type RuntimeWorkspacePackageDescriptor =
  (typeof RUNTIME_WORKSPACE_PACKAGES)[number];
