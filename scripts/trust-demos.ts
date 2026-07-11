import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

interface TrustDemoTrace {
  system: "kestrel" | "chat_loop_baseline";
  scenarioId: string;
  unattended: true;
  steps: Array<{
    at: string;
    event: string;
    detail: string;
    traceRef: string;
  }>;
  outcome: "success" | "partial" | "failed";
  auditable: boolean;
}

interface TrustDemoReportV1 {
  version: "trust_demo_report_v1";
  generatedAt: string;
  synthetic: true;
  scenarios: Array<{
    scenarioId: string;
    title: string;
    rationale: string;
    kestrel: TrustDemoTrace;
    baseline: TrustDemoTrace;
    comparison: {
      winner: "kestrel" | "chat_loop_baseline" | "tie";
      reason: string;
    };
    bundleLinks: {
      kestrel: string;
      baseline: string;
    };
  }>;
}

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, "docs", "generated", "trust-demos");
const REPORT_PATH = path.join(OUTPUT_DIR, "trust-demo-report.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "trust-demo-report.md");

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const scenarios = buildScenarios(generatedAt);
  const report: TrustDemoReportV1 = {
    version: "trust_demo_report_v1",
    generatedAt,
    synthetic: true,
    scenarios,
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(SUMMARY_PATH, renderSummary(report), "utf8");

  process.stdout.write(`trust demos report: ${path.relative(ROOT, REPORT_PATH)} scenarios=${scenarios.length}\n`);
  process.stdout.write(`trust demos summary: ${path.relative(ROOT, SUMMARY_PATH)}\n`);
}

function buildScenarios(generatedAt: string): TrustDemoReportV1["scenarios"] {
  return [
    {
      scenarioId: "approval-scope-enforcement",
      title: "Approval Scope Enforcement",
      rationale: "Validate that unattended execution remains blocked outside an explicit approval envelope.",
      kestrel: buildTrace({
        generatedAt,
        system: "kestrel",
        scenarioId: "approval-scope-enforcement",
        steps: [
          ["interaction.requested", "Approval request emitted with explicit tool/capability scope."],
          ["approval.granted", "Scoped grant recorded with allowlist."],
          ["run.completed", "Execution continued only within granted scope."],
        ],
        outcome: "success",
      }),
      baseline: buildTrace({
        generatedAt,
        system: "chat_loop_baseline",
        scenarioId: "approval-scope-enforcement",
        steps: [
          ["message.received", "Natural-language approval interpreted without typed scope."],
          ["tool.invoked", "Tool call proceeded with implicit capability expansion."],
          ["run.completed", "Outcome succeeded but without auditable scoped grant."],
        ],
        outcome: "partial",
      }),
      comparison: {
        winner: "kestrel",
        reason: "Kestrel preserves an auditable, typed approval envelope for unattended continuation.",
      },
      bundleLinks: {
        kestrel: "docs/generated/trust-demos/bundles/approval-scope-enforcement-kestrel.json",
        baseline: "docs/generated/trust-demos/bundles/approval-scope-enforcement-baseline.json",
      },
    },
    {
      scenarioId: "delegation-wait-resume",
      title: "Delegation Wait/Resume",
      rationale: "Verify child-thread wait propagation and deterministic parent resume under unattended mode.",
      kestrel: buildTrace({
        generatedAt,
        system: "kestrel",
        scenarioId: "delegation-wait-resume",
        steps: [
          ["delegation.spawned", "Child thread launched with explicit parent linkage."],
          ["delegation.waiting", "Parent thread entered delegation wait with blocker chain."],
          ["delegation.completed", "Child terminal state propagated; parent resumed deterministically."],
        ],
        outcome: "success",
      }),
      baseline: buildTrace({
        generatedAt,
        system: "chat_loop_baseline",
        scenarioId: "delegation-wait-resume",
        steps: [
          ["task.spawned", "Background task requested."],
          ["status.unknown", "No typed blocker chain for parent/child linkage."],
          ["manual.recovery", "Operator intervention required to reconcile outputs."],
        ],
        outcome: "partial",
      }),
      comparison: {
        winner: "kestrel",
        reason: "Kestrel retains parent/child lineage and deterministic wait-resume semantics.",
      },
      bundleLinks: {
        kestrel: "docs/generated/trust-demos/bundles/delegation-wait-resume-kestrel.json",
        baseline: "docs/generated/trust-demos/bundles/delegation-wait-resume-baseline.json",
      },
    },
    {
      scenarioId: "replay-reproducibility",
      title: "Replay Reproducibility",
      rationale: "Compare post-hoc audit depth for unattended runs.",
      kestrel: buildTrace({
        generatedAt,
        system: "kestrel",
        scenarioId: "replay-reproducibility",
        steps: [
          ["run.completed", "Terminal state persisted with run/session/thread IDs."],
          ["runtime.bundle.exported", "Single portable replay bundle exported."],
          ["doctor.report.generated", "Doctor summary produced from persisted replay stream."],
        ],
        outcome: "success",
      }),
      baseline: buildTrace({
        generatedAt,
        system: "chat_loop_baseline",
        scenarioId: "replay-reproducibility",
        steps: [
          ["chat.completed", "Conversation terminal text produced."],
          ["history.exported", "Message transcript available without transition lineage."],
          ["audit.gap", "No deterministic replay artifact for runtime reconstruction."],
        ],
        outcome: "partial",
      }),
      comparison: {
        winner: "kestrel",
        reason: "Kestrel emits replay and doctor artifacts that can be independently audited.",
      },
      bundleLinks: {
        kestrel: "docs/generated/trust-demos/bundles/replay-reproducibility-kestrel.json",
        baseline: "docs/generated/trust-demos/bundles/replay-reproducibility-baseline.json",
      },
    },
  ];
}

function buildTrace(input: {
  generatedAt: string;
  system: TrustDemoTrace["system"];
  scenarioId: string;
  steps: Array<[event: string, detail: string]>;
  outcome: TrustDemoTrace["outcome"];
}): TrustDemoTrace {
  return {
    system: input.system,
    scenarioId: input.scenarioId,
    unattended: true,
    steps: input.steps.map(([event, detail], index) => ({
      at: input.generatedAt,
      event,
      detail,
      traceRef: `${input.system}:${input.scenarioId}:${String(index + 1).padStart(2, "0")}`,
    })),
    outcome: input.outcome,
    auditable: input.system === "kestrel",
  };
}

function renderSummary(report: TrustDemoReportV1): string {
  const verifiedDate = report.generatedAt.slice(0, 10);
  const rows = report.scenarios
    .map(
      (scenario) =>
        `| \`${scenario.scenarioId}\` | ${scenario.comparison.winner} | ${scenario.comparison.reason} |`,
    )
    .join("\n");
  return [
    "---",
    "id: generated-trust-demos-report",
    "domain: runtime",
    "status: generated",
    "owner: kestrel-runtime",
    `last_verified_at: ${verifiedDate}`,
    "depends_on:",
    "  - ../../scripts/trust-demos.ts",
    "---",
    "",
    "# Trust Demos (Synthetic v1)",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "| Scenario | Winner | Reason |",
    "| --- | --- | --- |",
    rows,
    "",
    "These v1 demos are synthetic-only and deterministic by design.",
    "",
  ].join("\n");
}

void main().catch((error) => {
  process.stderr.write(`trust:demos failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
