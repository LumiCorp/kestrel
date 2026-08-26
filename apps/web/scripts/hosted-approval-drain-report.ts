import "server-only";

import { sql } from "drizzle-orm";
import { evaluateHostedApprovalDatabaseDrain } from "@/lib/apps/hosted-approval-drain-contract";
import { knowledgeDb } from "@/lib/knowledge/db";

const INCIDENT_THREAD_ID = "36dd83cc-5dc8-4343-914a-f2bd71026b60";
const observedSince = requiredTimestamp(argumentValue("--since"));
const now = new Date();
const rows = await knowledgeDb.execute(sql`
  SELECT
    count(*) FILTER (
      WHERE interaction.response_envelope IS NOT NULL
        AND interaction.resolved_at >= ${observedSince}
        AND coalesce(
          interaction.request_envelope->>'version',
          'v1'
        ) <> 'runner_hosted_tool_approval_interaction_v3'
    )::int AS "compatibilityDecisions",
    count(*) FILTER (
      WHERE interaction.status IN ('pending', 'processing')
        AND coalesce(
          interaction.request_envelope->>'version',
          'v1'
        ) <> 'runner_hosted_tool_approval_interaction_v3'
    )::int AS "pendingOldInteractions",
    (
      SELECT count(*)::int
      FROM app_operation_approvals approval
      WHERE approval.lifecycle_version = 'legacy_v1'
        AND approval.status IN ('pending', 'approved')
        AND approval.expires_at > ${now}
    ) AS "actionableLegacyProviderApprovals",
    (
      SELECT count(*)::int
      FROM app_operation_approvals approval
      WHERE approval.lifecycle_version = 'legacy_v1'
        AND approval.status = 'consumed'
        AND approval.consumed_at >= ${observedSince}
    ) AS "legacyProviderConsumptions",
    count(*) FILTER (
      WHERE interaction.thread_id = ${INCIDENT_THREAD_ID}
        AND (
          interaction.status IS DISTINCT FROM 'failed'
          OR interaction.response_failure_code IS DISTINCT FROM
            'HISTORICAL_HOSTED_APP_GRANT_MISSING'
          OR interaction.effect_status IS DISTINCT FROM 'not_started'
        )
    )::int AS "nonterminalIncidentInteractions",
    (
      SELECT max(approval.expires_at)
      FROM app_operation_approvals approval
      WHERE approval.lifecycle_version = 'legacy_v1'
        AND approval.status IN ('pending', 'approved')
    ) AS "latestLegacyExpiry",
    count(*) FILTER (
      WHERE interaction.request_envelope->>'version' =
        'runner_hosted_tool_approval_interaction_v3'
        AND interaction.created_at >= ${observedSince}
    )::int AS "v3InteractionsObserved"
  FROM thread_interactions interaction
  WHERE interaction.kind = 'approval'
`);
const row = Array.from(rows)[0] as Record<string, unknown> | undefined;
if (!row) throw new Error("HOSTED_APPROVAL_DRAIN_QUERY_EMPTY");
const report = evaluateHostedApprovalDatabaseDrain({
  observedSince: observedSince.toISOString(),
  generatedAt: now.toISOString(),
  counts: {
    compatibilityDecisions: readCount(row.compatibilityDecisions),
    pendingOldInteractions: readCount(row.pendingOldInteractions),
    actionableLegacyProviderApprovals: readCount(
      row.actionableLegacyProviderApprovals,
    ),
    legacyProviderConsumptions: readCount(row.legacyProviderConsumptions),
    nonterminalIncidentInteractions: readCount(
      row.nonterminalIncidentInteractions,
    ),
  },
  latestLegacyExpiry: readTimestamp(row.latestLegacyExpiry),
});
process.stdout.write(
  `${JSON.stringify(
    {
      ...report,
      v3InteractionsObserved: readCount(row.v3InteractionsObserved),
    },
    null,
    2,
  )}\n`,
);

function argumentValue(name: string) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) {
    throw new Error(`${name} <ISO timestamp> is required.`);
  }
  const unknown = args.filter(
    (argument, argumentIndex) =>
      argumentIndex !== index && argumentIndex !== index + 1,
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown arguments: ${unknown.join(", ")}`);
  }
  return args[index + 1]!;
}

function requiredTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("--since must be an ISO timestamp.");
  }
  return parsed;
}

function readCount(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("HOSTED_APPROVAL_DRAIN_COUNT_INVALID");
  }
  return parsed;
}

function readTimestamp(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("HOSTED_APPROVAL_DRAIN_TIMESTAMP_INVALID");
  }
  return parsed.toISOString();
}
