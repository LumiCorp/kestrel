export interface DesktopStartupSequence {
  showBootWindow(): Promise<void>;
  startServices(): Promise<void>;
  reportFailure(error: unknown): Promise<void>;
}

/**
 * The recovery surface must exist before any persisted-state or Core work can
 * block. Service startup remains asynchronous so the boot renderer can show
 * the current phase and receive a failure rather than the app disappearing.
 */
export async function startDesktopStartup(
  input: DesktopStartupSequence,
): Promise<void> {
  await input.showBootWindow();
  void input.startServices().catch(async (error) => {
    await input.reportFailure(error);
  });
}
