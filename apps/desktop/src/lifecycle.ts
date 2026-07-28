export interface DesktopBeforeQuitEvent {
  preventDefault(): void;
}

export interface DesktopShutdownPreparationOptions {
  stopProjectRuns?: (() => Promise<void> | void) | undefined;
  closeAdapters?: (() => Promise<void> | void) | undefined;
  stopRunner?: (() => Promise<void> | void) | undefined;
  closeDatabase?: (() => Promise<void> | void) | undefined;
}

export interface DesktopShutdownPreparation {
  prepare(input?: {
    cancelActiveWork?: boolean | undefined;
  }): Promise<void>;
  isPrepared(): boolean;
}

export function createDesktopShutdownPreparation(
  options: DesktopShutdownPreparationOptions,
): DesktopShutdownPreparation {
  let prepared = false;
  let pending: Promise<void> | undefined;

  return {
    prepare(input = {}) {
      if (prepared) {
        return Promise.resolve();
      }
      if (pending !== undefined) {
        return pending;
      }
      pending = (async () => {
        if (input.cancelActiveWork !== false) {
          await options.stopProjectRuns?.();
        }
        await options.closeAdapters?.();
        await options.stopRunner?.();
        await options.closeDatabase?.();
        prepared = true;
      })().catch((cause) => {
        pending = undefined;
        throw cause;
      });
      return pending;
    },
    isPrepared() {
      return prepared;
    },
  };
}

export function createDesktopBeforeQuitHandler(options: {
  preparation: DesktopShutdownPreparation;
  quitApp: () => void;
}): (event: DesktopBeforeQuitEvent) => void {
  let handled = false;

  return (event: DesktopBeforeQuitEvent) => {
    if (handled) {
      return;
    }
    handled = true;
    event.preventDefault();
    void options.preparation
      .prepare()
      .catch(() => {})
      .finally(options.quitApp);
  };
}
