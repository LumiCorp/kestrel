import {
  DEFAULT_CODE_MODE_DISABLED_CONFIG,
  resolveRuntimeProfileSelection,
} from "../../src/index.js";
import type { TuiAppContext } from "./TuiAppContext.js";

export class CodeModeController {
  private readonly context: TuiAppContext;

  constructor(context: TuiAppContext) {
    this.context = context;
  }

  async handleCodeCommandSafely(args: string[]): Promise<void> {
    try {
      await this.handleCodeCommand(args);
    } catch (error) {
      await this.context.appendHistoryLine(
        "system",
        `Code command failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async handleCodeCommand(args: string[]): Promise<void> {
    const [subcommand] = args;
    const state = this.context.uiStore.getState();
    const current = state.activeProfile.codeMode;

    if (subcommand === undefined) {
      this.context.navigateToView("code");
      await this.context.persistUiState();
      return;
    }

    if (subcommand === "help") {
      await this.context.appendHistoryLine(
        "system",
        [
          "Code commands:",
          "/code status",
          "/code policy",
          "/code enable",
          "/code disable",
        ].join("\n"),
      );
      return;
    }

    if (subcommand === "status") {
      await this.context.appendHistoryLine(
        "system",
        current?.enabled === true
          ? "code-mode: enabled"
          : "code-mode: disabled",
      );
      return;
    }

    if (subcommand === "policy") {
      const policy = current;
      if (policy === undefined) {
        await this.context.appendHistoryLine("system", "No code-mode policy configured.");
        return;
      }

      await this.context.appendHistoryLine(
        "system",
        [
          `code-mode enabled=${policy.enabled ? "true" : "false"} approval=${policy.approvalMode}`,
          `languages=${policy.languages.join(",")}`,
          `sandbox executor=${policy.sandbox.executor} timeoutMs=${policy.sandbox.timeoutMs} memoryMb=${policy.sandbox.memoryMb} cpuShares=${policy.sandbox.cpuShares}`,
          `sandbox networkDefault=${policy.sandbox.networkDefault} allowDependencyInstall=${policy.sandbox.allowDependencyInstall ? "true" : "false"} maxOutputBytes=${policy.sandbox.maxOutputBytes} maxArtifacts=${policy.sandbox.maxArtifacts} maxArtifactBytes=${policy.sandbox.maxArtifactBytes}`,
          `retention persistSummary=${policy.retention.persistSummary ? "true" : "false"} persistArtifacts=${policy.retention.persistArtifacts ? "true" : "false"}`,
        ].join("\n"),
      );
      return;
    }

    if (subcommand === "enable" || subcommand === "disable") {
      const enabled = subcommand === "enable";
      const nextCapabilityPacks = new Set(state.activeProfile.capabilityPacks ?? []);
      if (enabled) {
        nextCapabilityPacks.add("sandbox_code");
      } else {
        nextCapabilityPacks.delete("sandbox_code");
      }
      const nextAllowlist = new Set(state.activeProfile.toolAllowlist ?? []);
      if (enabled === false) {
        nextAllowlist.delete("code.execute");
      }
      const resolved = resolveRuntimeProfileSelection({
        shellKind: state.activeProfile.shellKind ?? "cli",
        presetId: state.activeProfile.presetId,
        capabilityPacks: [...nextCapabilityPacks],
        toolAllowlist: [...nextAllowlist],
      });

      await this.context.persistActiveProfile({
        ...state.activeProfile,
        capabilityPacks: [...resolved.capabilityPacks],
        toolAllowlist: [...resolved.toolAllowlist],
        codeMode: {
          ...(state.activeProfile.codeMode ?? DEFAULT_CODE_MODE_DISABLED_CONFIG),
          ...resolved.codeMode,
          approvalMode: "auto",
        },
        devShell: resolved.devShell,
      });
      await this.context.appendHistoryLine("system", `code-mode ${enabled ? "enabled" : "disabled"}.`);
      return;
    }

    await this.context.appendHistoryLine("system", `Unknown /code subcommand '${subcommand}'. Try '/code help'.`);
  }
}
