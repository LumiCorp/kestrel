export interface DesktopBeforeQuitEvent {
  preventDefault(): void;
}

export interface DesktopBeforeQuitHandlerOptions {
  stopProjectRuns?: (() => Promise<void> | void) | undefined;
  closeWebServer?: (() => Promise<void> | void) | undefined;
  stopRunner?: (() => Promise<void> | void) | undefined;
  quitApp: () => void;
}

export function createDesktopBeforeQuitHandler(
  options: DesktopBeforeQuitHandlerOptions,
): (event: DesktopBeforeQuitEvent) => void {
  let handled = false;

  return (event: DesktopBeforeQuitEvent) => {
    if (handled) {
      return;
    }
    handled = true;
    event.preventDefault();
    void (async () => {
      try {
        await options.stopProjectRuns?.();
        await Promise.all([
          options.closeWebServer?.(),
          options.stopRunner?.(),
        ]);
      } finally {
        options.quitApp();
      }
    })().catch(() => undefined);
  };
}
