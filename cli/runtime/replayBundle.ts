import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { RunReplayService, type ReplayDoctorReport, type ReplayQuery, type ReplayResult } from "../../src/replay/RunReplayService.js";
import type { SessionStore } from "../../src/kestrel/contracts/store.js";


export interface RuntimeReplayBundleV1 {
  version: "runtime_replay_bundle_v1";
  generatedAt: string;
  query: ReplayQuery;
  focus: {
    runId?: string | undefined;
    sessionId?: string | undefined;
    threadId?: string | undefined;
    delegationId?: string | undefined;
  };
  replay: {
    summary: ReplayResult["summary"];
    events: ReplayResult["events"];
    transitions: ReplayResult["transitions"];
    timeline: ReplayResult["timeline"];
    groups: ReplayResult["groups"];
  };
  doctor: ReplayDoctorReport;
  reports: {
    lineage: ReplayResult["lineage"];
    waits: ReplayResult["waits"];
    approvals: ReplayResult["approvals"];
    delegations: ReplayResult["delegations"];
    supervision: ReplayResult["supervision"];
    compaction: ReplayResult["compaction"];
    assembly: ReplayResult["assembly"];
    compatibility?: ReplayResult["compatibility"] | undefined;
    adaptation?: ReplayResult["adaptation"] | undefined;
    evidenceRecovery?: ReplayResult["evidenceRecovery"] | undefined;
  };
  artifactReferences: string[];
}

export async function buildRuntimeReplayBundle(
  store: SessionStore,
  query: ReplayQuery,
): Promise<{ replay: ReplayResult; doctor: ReplayDoctorReport; bundle: RuntimeReplayBundleV1 }> {
  const service = new RunReplayService(store);
  const replay = await service.replay(query);
  const doctor = service.doctor(replay);
  const bundle: RuntimeReplayBundleV1 = {
    version: "runtime_replay_bundle_v1",
    generatedAt: new Date().toISOString(),
    query: {
      ...(query.runId !== undefined ? { runId: query.runId } : {}),
      ...(query.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
      ...(query.threadId !== undefined ? { threadId: query.threadId } : {}),
      ...(query.delegationId !== undefined ? { delegationId: query.delegationId } : {}),
      ...(query.fromTimestamp !== undefined ? { fromTimestamp: query.fromTimestamp } : {}),
      ...(query.toTimestamp !== undefined ? { toTimestamp: query.toTimestamp } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    },
    focus: {
      ...(doctor.focus.runId !== undefined ? { runId: doctor.focus.runId } : {}),
      ...(doctor.focus.sessionId !== undefined ? { sessionId: doctor.focus.sessionId } : {}),
      ...(doctor.focus.threadId !== undefined ? { threadId: doctor.focus.threadId } : {}),
      ...(doctor.focus.delegationId !== undefined ? { delegationId: doctor.focus.delegationId } : {}),
    },
    replay: {
      summary: replay.summary,
      events: replay.events,
      transitions: replay.transitions,
      timeline: replay.timeline,
      groups: replay.groups,
    },
    doctor,
    reports: {
      lineage: replay.lineage,
      waits: replay.waits,
      approvals: replay.approvals,
      delegations: replay.delegations,
      supervision: replay.supervision,
      compaction: replay.compaction,
      assembly: replay.assembly,
      ...(replay.compatibility !== undefined ? { compatibility: replay.compatibility } : {}),
      ...(replay.adaptation !== undefined ? { adaptation: replay.adaptation } : {}),
      ...(replay.evidenceRecovery !== undefined ? { evidenceRecovery: replay.evidenceRecovery } : {}),
    },
    artifactReferences: collectArtifactReferences(replay),
  };
  return { replay, doctor, bundle };
}

export async function writeRuntimeReplayBundle(
  store: SessionStore,
  query: ReplayQuery,
  outPath: string,
): Promise<RuntimeReplayBundleV1> {
  const { bundle } = await buildRuntimeReplayBundle(store, query);
  const target = resolve(process.cwd(), outPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return bundle;
}

export async function writeDoctorReport(
  store: SessionStore,
  query: ReplayQuery,
  outPath: string,
): Promise<ReplayDoctorReport> {
  const { doctor } = await buildRuntimeReplayBundle(store, query);
  const target = resolve(process.cwd(), outPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(doctor, null, 2)}\n`, "utf8");
  return doctor;
}

function collectArtifactReferences(replay: ReplayResult): string[] {
  const refs = new Set<string>();
  for (const summary of replay.compaction.summaries) {
    refs.add(`context_summary:${summary.artifactId}`);
  }
  if (replay.compaction.latestSummary?.artifactId !== undefined) {
    refs.add(`latest_context_summary:${replay.compaction.latestSummary.artifactId}`);
  }
  if (replay.compaction.authoritativeSummary?.artifactId !== undefined) {
    refs.add(`authoritative_context_summary:${replay.compaction.authoritativeSummary.artifactId}`);
  }
  return [...refs.values()].sort((left, right) => left.localeCompare(right));
}
