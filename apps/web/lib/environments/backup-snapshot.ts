export type WorkspaceSnapshotEvidence = {
  flySnapshotId: string;
  flySnapshotSourceVolumeId: string;
  flySnapshotState: string;
  flySnapshotRequestedAt: string;
  flySnapshotLastObservedAt: string;
};

export type WorkspaceSnapshotObservation = {
  state: string;
  observedAt: string;
};

export async function acquireWorkspaceSnapshot(input: {
  appName: string;
  sourceVolumeId: string;
  persistedSnapshot?: WorkspaceSnapshotEvidence;
  createSnapshot: (snapshotInput: {
    appName: string;
    volumeId: string;
  }) => Promise<{ id: string; state: string }>;
  persistSnapshot: (snapshot: WorkspaceSnapshotEvidence) => Promise<void>;
  waitForSnapshot: (snapshotInput: {
    appName: string;
    sourceVolumeId: string;
    snapshotId: string;
  }) => Promise<WorkspaceSnapshotObservation>;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const requestedAt =
    input.persistedSnapshot?.flySnapshotRequestedAt ?? now().toISOString();
  if (
    input.persistedSnapshot &&
    input.persistedSnapshot.flySnapshotSourceVolumeId !== input.sourceVolumeId
  ) {
    throw Object.assign(
      new Error("Persisted Fly Workspace snapshot belongs to another volume."),
      { code: "WORKSPACE_BACKUP_SNAPSHOT_SOURCE_VOLUME_MISMATCH" },
    );
  }
  const snapshot = input.persistedSnapshot
    ? {
        id: input.persistedSnapshot.flySnapshotId,
        state: input.persistedSnapshot.flySnapshotState,
      }
    : await input.createSnapshot({
        appName: input.appName,
        volumeId: input.sourceVolumeId,
      });
  let evidence: WorkspaceSnapshotEvidence = {
    flySnapshotId: snapshot.id,
    flySnapshotSourceVolumeId: input.sourceVolumeId,
    flySnapshotState: snapshot.state,
    flySnapshotRequestedAt: requestedAt,
    flySnapshotLastObservedAt:
      input.persistedSnapshot?.flySnapshotLastObservedAt ?? requestedAt,
  };
  if (!input.persistedSnapshot) await input.persistSnapshot(evidence);
  try {
    const observation = await input.waitForSnapshot({
      appName: input.appName,
      sourceVolumeId: input.sourceVolumeId,
      snapshotId: snapshot.id,
    });
    evidence = {
      ...evidence,
      flySnapshotState: observation.state,
      flySnapshotLastObservedAt: observation.observedAt,
    };
    await input.persistSnapshot(evidence);
    return { id: snapshot.id, state: observation.state };
  } catch (error) {
    const observation = (error as { lastObservation?: WorkspaceSnapshotObservation })
      .lastObservation;
    if (observation) {
      await input.persistSnapshot({
        ...evidence,
        flySnapshotState: observation.state,
        flySnapshotLastObservedAt: observation.observedAt,
      });
    }
    throw error;
  }
}

export async function createAuxiliaryVolumeSnapshot(input: {
  appName: string;
  volumeId: string;
  createSnapshot: (snapshotInput: {
    appName: string;
    volumeId: string;
  }) => Promise<{ id: string; state: string }>;
}) {
  try {
    const snapshot = await input.createSnapshot({
      appName: input.appName,
      volumeId: input.volumeId,
    });
    return {
      id: snapshot.id,
      state: snapshot.state,
      errorMessage: null,
    };
  } catch (error) {
    return {
      id: null,
      state: "failed",
      errorMessage:
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Fly volume snapshot request failed.",
    };
  }
}
