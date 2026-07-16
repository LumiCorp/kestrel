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
