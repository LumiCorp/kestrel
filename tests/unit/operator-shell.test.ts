import assert from "node:assert/strict";

import {
  buildOperatorBackActionLabel,
  buildOperatorBootstrapSnapshot,
  buildChildMissionPrompt,
  buildOperatorCodeWorkspace,
  buildOperatorDelegationWorkspace,
  buildOperatorHistoryHome,
  buildOperatorHistoryNextActions,
  buildOperatorLaunchSetup,
  buildOperatorMcpWorkspace,
  buildOperatorNextActionsSnapshot,
  buildOperatorRecoveryCenter,
  buildOperatorStatusSnapshot,
  buildOperatorWorkspaceJourney,
  deriveOperatorJourney,
  formatOperatorLaunchSummary,
  formatOperatorMode,
  pickResumeTarget,
  resolveOperatorStartTask,
} from "../../src/operatorShell.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "formatOperatorMode renders legacy runtime mode values as Build labels", () => {
  assert.equal(formatOperatorMode("plan", undefined), "Plan");
  assert.equal(formatOperatorMode("act", "strict"), "Build");
});

contractTest("runtime.hermetic", "deriveOperatorJourney prefers explicit waiting and failure state", () => {
  const waiting = deriveOperatorJourney({
    id: "s1",
    title: "Waiting task",
    updatedAt: "2026-03-20T10:00:00.000Z",
    pendingWaitEventType: "user.reply",
  });
  const failed = deriveOperatorJourney({
    id: "s2",
    title: "Failed task",
    updatedAt: "2026-03-20T09:00:00.000Z",
    lastRunStatus: "FAILED",
  });

  assert.equal(waiting.recommendedAction, "resume_waiting");
  assert.equal(failed.recommendedAction, "recover_failed");
});

contractTest("runtime.hermetic", "pickResumeTarget prefers waiting sessions before failures and recents", () => {
  const selected = pickResumeTarget([
    {
      id: "recent",
      title: "Recent task",
      updatedAt: "2026-03-20T10:03:00.000Z",
    },
    {
      id: "failed",
      title: "Failed task",
      updatedAt: "2026-03-20T10:02:00.000Z",
      lastRunStatus: "FAILED",
    },
    {
      id: "waiting",
      title: "Waiting task",
      updatedAt: "2026-03-20T10:01:00.000Z",
      pendingWaitEventType: "user.approval",
    },
  ]);

  assert.equal(selected?.id, "waiting");
});

contractTest("runtime.hermetic", "buildOperatorStatusSnapshot turns runtime state into operator copy", () => {
  const snapshot = buildOperatorStatusSnapshot({
    title: "Launch copy",
    profileLabel: "reference-openai",
    workspaceLabel: "workspace=demo",
    interactionMode: "build",
    actSubmode: "safe",
    pendingWaitEventType: "user.approval",
    mcpSummary: "healthy",
    isActive: true,
  });

  assert.equal(snapshot.lifecycle, "waiting");
  assert.equal(snapshot.recommendedLabel, "Resume waiting session");
  assert.match(snapshot.subline, /reference-openai/u);
});

contractTest("runtime.hermetic", "buildOperatorBackActionLabel derives stack-aware labels deterministically", () => {
  assert.equal(buildOperatorBackActionLabel(undefined), "Back to Chat");
  assert.equal(buildOperatorBackActionLabel("history"), "Back to History");
  assert.equal(buildOperatorBackActionLabel("workspace"), "Back to Workspace");
});

contractTest("runtime.hermetic", "buildOperatorHistoryHome orders active, waiting, failed, and recent entries deterministically", () => {
  const entries = buildOperatorHistoryHome([
    {
      id: "recent",
      title: "Recent task",
      updatedAt: "2026-03-20T10:03:00.000Z",
      profileLabel: "Reference",
      workspaceLabel: "workspace=demo",
      restartAvailable: true,
    },
    {
      id: "failed",
      title: "Failed task",
      updatedAt: "2026-03-20T10:02:00.000Z",
      lastRunStatus: "FAILED",
      profileLabel: "Reference",
      restartAvailable: true,
      hasSummary: true,
    },
    {
      id: "waiting",
      title: "Waiting task",
      updatedAt: "2026-03-20T10:01:00.000Z",
      pendingWaitEventType: "user.approval",
      hasArtifacts: true,
      restartAvailable: true,
    },
    {
      id: "active",
      title: "Active task",
      updatedAt: "2026-03-20T10:00:00.000Z",
      isActive: true,
      profileLabel: "Reference",
      workspaceLabel: "workspace=demo",
      launchSummary: "Task=Active task · Profile=Reference · Mode=plan · Workspace=workspace=demo · Launch=empty",
      restartAvailable: true,
    },
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["active", "waiting", "failed", "recent"],
  );
  assert.equal(entries[1]?.hasArtifacts, true);
  assert.equal(entries[2]?.hasSummary, true);
  assert.equal(entries[3]?.restartAvailable, true);
});

contractTest("runtime.hermetic", "resolveOperatorStartTask applies explicit defaults deterministically", () => {
  const launch = resolveOperatorStartTask({
    title: "Investigate queue latency",
    presetId: "investigation",
    templateId: "investigation-task",
    defaultProfileId: "reference-openai",
    defaultProfileLabel: "Reference OpenAI",
    defaultInteractionMode: "plan",
    defaultActSubmode: "safe",
    workspaceBinding: "active",
    workspaceId: "workspace-demo",
    workspaceLabel: "workspace=demo",
  });

  assert.equal(launch.profileId, "reference-openai");
  assert.equal(launch.profileLabel, "Reference OpenAI");
  assert.equal(launch.agentProfileId, "reference-openai");
  assert.equal(launch.agentProfileLabel, "Reference OpenAI");
  assert.equal(launch.interactionMode, "plan");
  assert.equal(launch.workspace.binding, "active");
  assert.equal(launch.launchKind, "empty");
  assert.match(formatOperatorLaunchSummary(launch), /Task=Investigate queue latency/u);
  assert.match(formatOperatorLaunchSummary(launch), /Preset=Investigation/u);
});

contractTest("runtime.hermetic", "resolveOperatorStartTask preserves explicit runtime identity fields", () => {
  const launch = resolveOperatorStartTask({
    title: "Inspect desktop runtime",
    profileId: "reference-web",
    profileLabel: "Reference React (Web)",
    agentProfileId: "reference-web",
    agentProfileLabel: "Reference React",
    environmentShellKind: "desktop",
    environmentPresetId: "desktop_dev_local",
    environmentCapabilityPackIds: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
    effectiveAssemblyId: "bundle:reference-web:default",
    effectiveAssemblyLabel: "Reference React on desktop:desktop_dev_local",
    defaultProfileId: "reference-web",
    defaultInteractionMode: "plan",
    defaultActSubmode: "safe",
    requireTitle: true,
  });

  assert.equal(launch.agentProfileId, "reference-web");
  assert.equal(launch.agentProfileLabel, "Reference React");
  assert.equal(launch.environmentShellKind, "desktop");
  assert.equal(launch.environmentPresetId, "desktop_dev_local");
  assert.deepEqual(launch.environmentCapabilityPackIds, ["balanced", "filesystem", "dev_shell", "sandbox_code"]);
  assert.equal(launch.effectiveAssemblyId, "bundle:reference-web:default");
  assert.equal(launch.effectiveAssemblyLabel, "Reference React on desktop:desktop_dev_local");
});

contractTest("runtime.hermetic", "resolveOperatorStartTask infers prompt-seeded launch kind from explicit prompt only", () => {
  const launch = resolveOperatorStartTask({
    title: "Recover blocked run",
    initialPrompt: "Inspect the failure and propose next action.",
    interactionMode: "build",
    defaultProfileId: "reference-openai",
    defaultInteractionMode: "plan",
    defaultActSubmode: "safe",
    requireTitle: true,
  });

  assert.equal(launch.launchKind, "prompt_seeded");
  assert.equal(launch.interactionMode, "build");
  assert.equal(launch.actSubmode, "safe");
});

contractTest("runtime.hermetic", "buildOperatorWorkspaceJourney derives mismatch and discovered workspace state from explicit input", () => {
  const snapshot = buildOperatorWorkspaceJourney({
    sessionTitle: "Workspace drill",
    profileLabel: "Reference",
    workspaceLabel: "workspace=alpha",
    launchWorkspaceLabel: "workspace=beta",
    interactionMode: "plan",
    discoveredWorkspaces: [
      {
        workspaceId: "alpha",
        label: "workspace=alpha",
        rootPath: "/tmp/alpha",
        isCurrentBinding: true,
        isLaunchWorkspace: false,
      },
      {
        workspaceId: "beta",
        label: "workspace=beta",
        rootPath: "/tmp/beta",
        isCurrentBinding: false,
        isLaunchWorkspace: true,
      },
    ],
  });

  assert.equal(snapshot.title, "Workspace");
  assert.equal(snapshot.discoveredWorkspaces.length, 2);
  assert.match(snapshot.mismatchSummary ?? "", /differs from session workspace/u);
  assert.equal(snapshot.nextActions?.destination, "workspace");
});

contractTest("runtime.hermetic", "buildOperatorMcpWorkspace derives degraded workspace state from explicit MCP snapshot", () => {
  const snapshot = buildOperatorMcpWorkspace({
    sessionTitle: "Investigate MCP",
    profileLabel: "Reference",
    workspaceLabel: "workspace=demo",
    interactionMode: "plan",
    status: {
      healthy: false,
      checkedAt: "2026-03-21T11:00:00.000Z",
      servers: [
        {
          serverId: "docker-gw",
          transport: "stdio",
          healthy: false,
          connected: false,
          enabled: true,
          toolCount: 0,
          checkedAt: "2026-03-21T11:00:00.000Z",
          error: "connection refused",
        },
      ],
      tools: [],
    },
  });

  assert.equal(snapshot.healthLabel, "degraded");
  assert.equal(snapshot.issueFlags.includes("MCP health degraded"), true);
  assert.equal(snapshot.servers[0]?.id, "docker-gw");
  assert.equal(snapshot.primaryActions[0]?.command, "/mcp refresh");
  assert.equal(snapshot.nextActions?.orderedActions[0]?.id, "mcp.refresh");
});

contractTest("runtime.hermetic", "mcp workspace exposes concrete remove actions only for known servers", () => {
  const empty = buildOperatorMcpWorkspace({
    sessionTitle: "active",
    profileLabel: "Reference",
    status: {
      healthy: true,
      checkedAt: "2026-03-05T11:00:00.000Z",
      servers: [],
      tools: [],
    },
  });
  assert.equal(
    empty.primaryActions.concat(empty.secondaryActions).some((action) => action.draft === "/mcp remove "),
    false,
  );

  const withServer = buildOperatorMcpWorkspace({
    sessionTitle: "active",
    profileLabel: "Reference",
    status: {
      healthy: true,
      checkedAt: "2026-03-05T11:00:00.000Z",
      servers: [
        {
          serverId: "docker-gw",
          transport: "stdio",
          enabled: true,
          healthy: true,
          connected: true,
          toolCount: 3,
          checkedAt: "2026-03-05T11:00:00.000Z",
        },
      ],
      tools: [],
    },
  });
  assert.equal(
    withServer.primaryActions.concat(withServer.secondaryActions).some((action) => action.command === "/mcp remove docker-gw"),
    true,
  );
});

contractTest("runtime.hermetic", "buildOperatorCodeWorkspace derives deterministic code policy summary", () => {
  const snapshot = buildOperatorCodeWorkspace({
    sessionTitle: "Investigate queue latency",
    profileLabel: "Reference",
    workspaceLabel: "workspace=demo",
    interactionMode: "build",
    actSubmode: "safe",
    codeMode: {
      enabled: true,
      languages: ["javascript", "python"],
      sandbox: {
        executor: "docker",
        timeoutMs: 20_000,
        memoryMb: 256,
        cpuShares: 256,
        networkDefault: "off",
        allowDependencyInstall: false,
        maxOutputBytes: 32_000,
        maxArtifacts: 20,
        maxArtifactBytes: 64_000,
      },
      retention: {
        persistSummary: true,
        persistArtifacts: true,
      },
      approvalMode: "auto",
    },
    latestHint: "Summary ready",
    hasArtifacts: true,
    hasSummary: true,
  });

  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.approvalMode, "auto");
  assert.match(snapshot.sandboxSummary, /docker/u);
  assert.equal(snapshot.primaryActions[0]?.command, "/code policy");
  assert.equal(snapshot.nextActions?.orderedActions[0]?.id, "code.policy");
});

contractTest("runtime.hermetic", "next action snapshots keep deterministic destination parity across journey surfaces", () => {
  const historyEntries = buildOperatorHistoryHome([
    {
      id: "session-1",
      title: "Waiting task",
      updatedAt: "2026-03-22T10:00:00.000Z",
      pendingWaitEventType: "user.reply",
    },
  ]);
  const history = buildOperatorHistoryNextActions(historyEntries);
  const mcp = buildOperatorNextActionsSnapshot({
    destination: "mcp",
    recommendedLabel: "Refresh MCP status.",
    issueFlags: ["MCP health degraded"],
    actions: [
      { id: "mcp.refresh", label: "Refresh status", command: "/mcp refresh" },
      { id: "mcp.servers", label: "Inspect servers", command: "/mcp servers" },
    ],
    preferredActionIds: ["mcp.refresh"],
  });
  const code = buildOperatorNextActionsSnapshot({
    destination: "code",
    recommendedLabel: "Inspect code posture before execution.",
    issueFlags: [],
    actions: [
      { id: "code.policy", label: "Inspect policy", command: "/code policy" },
      { id: "code.run", label: "Continue in chat", command: "/status", targetDestination: "chat" },
    ],
    preferredActionIds: ["code.policy"],
  });
  const delegation = buildOperatorDelegationWorkspace({
    sessionTitle: "Delegation",
    profileLabel: "Reference",
    interactionMode: "plan",
    delegation: {
      childOutcomes: [
        { threadId: "child-1", title: "Collect evidence", status: "COMPLETED" },
      ],
    },
  }).nextActions;
  const recovery = buildOperatorRecoveryCenter({
    sessionTitle: "Recovery",
    profileLabel: "Reference",
    interactionMode: "plan",
    recovery: {
      latestCheckpoint: {
        checkpointId: "ctx-1",
        status: "PENDING",
        recommendedAction: "continue",
        reason: "context pressure",
      },
    },
  }).nextActions;

  assert.equal(history.destination, "history");
  assert.equal(mcp.destination, "mcp");
  assert.equal(code.destination, "code");
  assert.equal(delegation?.destination, "delegation");
  assert.equal(recovery?.destination, "recovery");
  assert.equal(history.orderedActions[0]?.id, "history.open.session-1");
  assert.equal(mcp.orderedActions[0]?.id, "mcp.refresh");
  assert.equal(code.orderedActions[0]?.id, "code.policy");
});

contractTest("runtime.hermetic", "buildOperatorDelegationWorkspace derives child review state from explicit input", () => {
  const snapshot = buildOperatorDelegationWorkspace({
    sessionTitle: "Review child outcomes",
    profileLabel: "Reference",
    workspaceLabel: "workspace=demo",
    interactionMode: "plan",
    delegation: {
      childThreads: [
        {
          threadId: "child-1",
          title: "Search sources",
          status: "WAITING",
          waitEventType: "user.reply",
        },
      ],
      childOutcomes: [
        {
          threadId: "child-2",
          title: "Write draft",
          status: "COMPLETED",
          summary: "Draft summary ready.",
        },
      ],
      nextActionKind: "resolve_fan_in_checkpoint",
      nextActionSummary: "Review child outcomes before fan-in.",
      childBlockerReason: "Waiting on operator reply",
      fanInDisposition: {
        status: "pending_checkpoint",
        checkpointId: "fan-1",
      },
      inboxChildBlockers: 1,
    },
  });

  assert.equal(snapshot.childThreads.length, 1);
  assert.equal(snapshot.childOutcomes.length, 1);
  assert.equal(snapshot.childOutcomes[0]?.readiness, "ready");
  assert.match(snapshot.childOutcomes[0]?.recommendedAction ?? "", /fan-in/i);
  assert.equal(snapshot.nextActionSummary, "Review child outcomes before fan-in.");
  assert.equal(snapshot.nextValidActionSummary, "Resolve the blocker or supersede the child branch.");
  assert.equal(snapshot.issueFlags.includes("Waiting on operator reply"), true);
  assert.equal(snapshot.primaryActions[0]?.draft, "/child spawn ");
  assert.equal(snapshot.nextActions?.orderedActions[0]?.id, "focus.child");
  assert.equal(snapshot.primaryActions.some((action) => action.command === "/fanin accept fan-1"), true);
  assert.equal(snapshot.secondaryActions.some((action) => action.command === "/focus child-1"), true);
});

contractTest("runtime.hermetic", "buildOperatorDelegationWorkspace derives outcome preview from result envelope", () => {
  const snapshot = buildOperatorDelegationWorkspace({
    sessionTitle: "Review child outcomes",
    profileLabel: "Reference",
    interactionMode: "build",
    delegation: {
      childOutcomes: [
        {
          threadId: "child-1",
          title: "Verify UI",
          status: "COMPLETED",
          result: {
            status: "completed",
            result: "UI path verified.",
            references: ["file:///tmp/ui.md"],
          },
        },
      ],
    },
  });

  assert.equal(snapshot.childOutcomes[0]?.summary, "UI path verified.");
  assert.equal(snapshot.childOutcomes[0]?.latestPreview, "UI path verified.");
  assert.equal(snapshot.childOutcomes[0]?.hasSummary, true);
  assert.equal(snapshot.childOutcomes[0]?.resultStatus, "completed");
  assert.deepEqual(snapshot.childOutcomes[0]?.references, ["file:///tmp/ui.md"]);
});

contractTest("runtime.hermetic", "buildOperatorDelegationWorkspace preserves error and reference only outcomes", () => {
  const snapshot = buildOperatorDelegationWorkspace({
    sessionTitle: "Review child outcomes",
    profileLabel: "Reference",
    interactionMode: "build",
    delegation: {
      childOutcomes: [
        {
          threadId: "child-error",
          title: "Error only",
          status: "FAILED",
          errorCode: "CHILD_FAILED",
          error: "Child run failed.",
        },
        {
          threadId: "child-reference",
          title: "Reference only",
          status: "COMPLETED",
          references: ["file:///tmp/reference.md"],
        },
      ],
    },
  });

  assert.equal(snapshot.childOutcomes[0]?.errorCode, "CHILD_FAILED");
  assert.equal(snapshot.childOutcomes[0]?.error, "Child run failed.");
  assert.deepEqual(snapshot.childOutcomes[1]?.references, ["file:///tmp/reference.md"]);
});

contractTest("runtime.hermetic", "delegation workspace hides fan-in and child-target actions without concrete ids", () => {
  const snapshot = buildOperatorDelegationWorkspace({
    sessionTitle: "active",
    profileLabel: "Reference",
    delegation: {
      childThreads: [],
      childOutcomes: [],
    },
  });

  const actions = snapshot.primaryActions.concat(snapshot.secondaryActions);
  assert.equal(actions.some((action) => action.command === "/fanin accept"), false);
  assert.equal(actions.some((action) => action.command === "/fanin defer"), false);
  assert.equal(actions.some((action) => action.draft === "/child supersede "), false);
  assert.equal(actions.some((action) => action.draft === "/focus "), false);
  assert.equal(actions.some((action) => action.draft === "/child spawn "), true);
});

contractTest("runtime.hermetic", "delegation workspace uses concrete fan-in checkpoint and child focus actions", () => {
  const snapshot = buildOperatorDelegationWorkspace({
    sessionTitle: "active",
    profileLabel: "Reference",
    delegation: {
      childThreads: [
        {
          threadId: "thread-child-1",
          title: "Child work",
          status: "WAITING",
          waitEventType: "user.reply",
        },
      ],
      childOutcomes: [],
      fanInDisposition: {
        status: "PENDING",
        checkpointId: "fan-in-1",
      },
    },
  });

  const actions = snapshot.primaryActions.concat(snapshot.secondaryActions);
  assert.equal(actions.some((action) => action.command === "/fanin accept fan-in-1"), true);
  assert.equal(actions.some((action) => action.command === "/fanin defer fan-in-1"), true);
  assert.equal(actions.some((action) => action.command === "/focus thread-child-1"), true);
});

contractTest("runtime.hermetic", "buildOperatorRecoveryCenter derives explicit checkpoint timeline", () => {
  const snapshot = buildOperatorRecoveryCenter({
    sessionTitle: "Recover failed run",
    profileLabel: "Reference",
    workspaceLabel: "workspace=demo",
    lastRunStatus: "FAILED",
    recovery: {
      latestCheckpoint: {
        checkpointId: "ctx-1",
        status: "PENDING",
        recommendedAction: "compact",
        reason: "Context pressure",
      },
      fanInDisposition: {
        status: "accepted",
        checkpointId: "fan-1",
        summary: "Accepted child summary.",
        at: "2026-03-21T11:00:00.000Z",
      },
      blockerSummary: "Model run failed",
      activeWaitDetail: "Waiting for operator",
      contextPosture: "checkpoint pending",
      latestReasoningMessage: "Failure rooted in missing evidence.",
      latestEvidenceIssues: ["low coverage", "missing primary source"],
      latestEvidenceTerminalOutcome: "recovered",
      latestPreview: "Recovery summary ready.",
    },
    checkpoints: [
      {
        checkpointId: "ws-1",
        sessionId: "session-1",
        workspaceRoot: "/tmp/demo",
        repoRoot: "/tmp/demo",
        label: "Before restore",
        isExplicitLabel: true,
        reason: "manual anchor",
        createdBy: "operator",
        createdAt: "2026-03-21T12:00:00.000Z",
        storageKind: "git_ref_v1",
        gitRef: "refs/kestrel/checkpoints/thread-main/ws-1",
        kind: "manual",
        retentionClass: "manual",
        captureStatus: "CAPTURED",
        manifestHash: "abc",
        fileCount: 3,
        totalBytes: 1200,
      },
    ],
  });

  assert.equal(snapshot.incidentLabel, "Failed run needs recovery");
  assert.equal(snapshot.timeline.length, 3);
  assert.equal(snapshot.timeline[0]?.kind, "workspace_checkpoint");
  assert.equal(snapshot.timeline[0]?.origin, "workspace");
  assert.match(snapshot.timeline[0]?.actionConsequence ?? "", /does not replay runtime state/u);
  assert.equal(snapshot.latestEvidence, "low coverage, missing primary source");
  assert.equal(snapshot.restorePreview?.workspaceRoot, "/tmp/demo");
  assert.match(snapshot.incident.cause, /Waiting for operator/u);
  assert.match(snapshot.incident.nextValidAction, /Use checkpoint accept\/defer/u);
  assert.equal(snapshot.postRunSummary.summaryState, "ready");
  assert.deepEqual(snapshot.postRunSummary.approvalsUsed, []);
  assert.equal(snapshot.notebook.length > 0, true);
  assert.equal(snapshot.primaryActions.some((action) => action.command === "/checkpoint inspect ws-1"), true);
  assert.equal(snapshot.primaryActions.some((action) => action.draft === "/checkpoint restore ws-1 "), true);
  assert.equal(snapshot.primaryActions.some((action) => action.command === "/checkpoint capture"), true);
  assert.equal(snapshot.nextActions?.orderedActions[0]?.id, "checkpoint.inspect.latest");
});

contractTest("runtime.hermetic", "recovery center hides checkpoint actions without concrete checkpoint state", () => {
  const snapshot = buildOperatorRecoveryCenter({
    sessionTitle: "active",
    profileLabel: "Reference",
    recovery: {},
    checkpoints: [],
  });

  const actions = snapshot.primaryActions.concat(snapshot.secondaryActions);
  assert.equal(actions.some((action) => action.command === "/checkpoint accept"), false);
  assert.equal(actions.some((action) => action.command === "/checkpoint defer"), false);
  assert.equal(actions.some((action) => action.command?.startsWith("/checkpoint inspect")), false);
  assert.equal(actions.some((action) => action.draft?.startsWith("/checkpoint restore")), false);
});

contractTest("runtime.hermetic", "recovery center uses concrete checkpoint ids for available actions", () => {
  const snapshot = buildOperatorRecoveryCenter({
    sessionTitle: "active",
    profileLabel: "Reference",
    recovery: {
      latestCheckpoint: {
        checkpointId: "context-1",
        status: "PENDING",
        recommendedAction: "compact",
        reason: "Context pressure",
      },
    },
    checkpoints: [
      {
        checkpointId: "workspace-1",
        sessionId: "session-1",
        threadId: "thread-1",
        workspaceRoot: "/tmp/workspace",
        repoRoot: "/tmp/workspace",
        label: "Workspace checkpoint",
        isExplicitLabel: true,
        reason: "Before risky edit",
        createdBy: "operator",
        createdAt: "2026-03-05T11:00:00.000Z",
        storageKind: "git_ref_v1",
        gitRef: "refs/kestrel/checkpoints/thread-1/workspace-1",
        kind: "manual",
        retentionClass: "manual",
        captureStatus: "CAPTURED",
        manifestHash: "hash",
        fileCount: 2,
        totalBytes: 128,
      },
    ],
  });

  const actions = snapshot.primaryActions.concat(snapshot.secondaryActions);
  assert.equal(actions.some((action) => action.command === "/checkpoint accept"), true);
  assert.equal(actions.some((action) => action.command === "/checkpoint defer"), true);
  assert.equal(actions.some((action) => action.command === "/checkpoint inspect workspace-1"), true);
  assert.equal(actions.some((action) => action.draft === "/checkpoint restore workspace-1 "), true);
});

contractTest("runtime.hermetic", "buildOperatorLaunchSetup returns fixed presets, templates, and relaunches", () => {
  const snapshot = buildOperatorLaunchSetup({
    profileLabel: "Reference",
    workspaceLabel: "Workspace=demo Root=/tmp/demo",
    recentSessions: [
      {
        id: "s-1",
        title: "Investigate queue latency",
        profileLabel: "Reference",
        workspaceLabel: "Workspace=demo Root=/tmp/demo",
        interactionMode: "plan",
        launchSummary: "Task=Investigate queue latency",
        recommendedLabel: "Resume recent session",
        presetId: "investigation",
        templateId: "investigation-task",
      },
    ],
  });

  assert.equal(snapshot.presets.length, 4);
  assert.equal(snapshot.templates.length, 4);
  assert.equal(snapshot.recentLaunches[0]?.templateId, "investigation-task");
  assert.equal(typeof snapshot.approvalPosture, "string");
  assert.equal(typeof snapshot.codePosture, "string");
  assert.match(snapshot.executionBoundarySummary, /profile-driven/u);
  assert.match(snapshot.bootstrapHint ?? "", /next history|next start|next chat/u);
});

contractTest("runtime.hermetic", "buildOperatorNextActionsSnapshot orders preferred actions deterministically", () => {
  const snapshot = buildOperatorNextActionsSnapshot({
    destination: "mcp",
    recommendedLabel: "Refresh MCP",
    issueFlags: ["MCP health degraded"],
    actions: [
      { id: "mcp.servers", label: "Inspect servers", command: "/mcp servers" },
      { id: "mcp.refresh", label: "Refresh status", command: "/mcp refresh" },
      { id: "nav.back", label: "Back to chat" },
    ],
    preferredActionIds: ["mcp.refresh", "mcp.servers"],
  });

  assert.equal(snapshot.destination, "mcp");
  assert.equal(snapshot.orderedActions.length, 2);
  assert.equal(snapshot.orderedActions[0]?.id, "mcp.refresh");
  assert.equal(snapshot.orderedActions[0]?.reason, "MCP health degraded");
  assert.match(snapshot.rationaleSummary, /MCP health degraded/u);
});

contractTest("runtime.hermetic", "buildOperatorHistoryNextActions derives deterministic history actions", () => {
  const snapshot = buildOperatorHistoryNextActions([
    {
      id: "waiting",
      title: "Waiting task",
      updatedAt: "2026-03-20T10:01:00.000Z",
      modeLabel: "plan",
      lifecycle: "waiting",
      recommendedAction: "resume_waiting",
      recommendedLabel: "Resume waiting session",
      detail: "Waiting for user approval",
      isActive: true,
      hasArtifacts: false,
      hasSummary: false,
      restartAvailable: true,
    },
  ]);

  assert.equal(snapshot.destination, "history");
  assert.equal(snapshot.orderedActions[0]?.label, "Resume waiting session");
  assert.equal(snapshot.orderedActions[1]?.id, "history.start");
});

contractTest("runtime.hermetic", "buildOperatorBootstrapSnapshot derives deterministic first-run recommendation", () => {
  const firstRun = buildOperatorBootstrapSnapshot({
    hasWorkspace: true,
    profileLabel: "Reference",
    presetCount: 4,
    runnerPreflightStatus: "ready",
    hasPriorSessionContext: false,
    hasWaitingOrFailed: false,
  });
  const returning = buildOperatorBootstrapSnapshot({
    hasWorkspace: false,
    profileLabel: "Reference",
    presetCount: 4,
    runnerPreflightStatus: "degraded",
    hasPriorSessionContext: true,
    hasWaitingOrFailed: true,
  });

  assert.equal(firstRun.recommendedInitialDestination, "start");
  assert.equal(returning.recommendedInitialDestination, "history");
  assert.equal(returning.runnerPreflightStatus, "degraded");
});

contractTest("runtime.hermetic", "buildChildMissionPrompt compiles an explicit child mission contract", () => {
  const prompt = buildChildMissionPrompt({
    title: "Collect sources",
    scope: "Find the missing primary documents.",
    returnCondition: "Return once the evidence summary is ready.",
    profileLabel: "Reference",
    interactionMode: "plan",
  });

  assert.match(prompt, /Mission: Collect sources/u);
  assert.match(prompt, /Return condition: Return once the evidence summary is ready\./u);
});
