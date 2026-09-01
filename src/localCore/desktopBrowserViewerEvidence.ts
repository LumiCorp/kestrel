import {
  DiagnosticLogStore,
  type DiagnosticLogEntry,
} from "../../cli/diagnostics/DiagnosticLogStore.js";

import type {
  DesktopBrowserViewerEventSink,
  DesktopBrowserViewerEventV1,
} from "./desktopBrowserService.js";

const DESKTOP_BROWSER_VIEWER_DIAGNOSTIC_SCOPE = "desktop.browser.viewer";

type DesktopBrowserViewerDiagnosticStore = Pick<DiagnosticLogStore, "append">;

/**
 * Bridges packaged Desktop Browser viewer lifecycle evidence into Local Core's
 * existing durable diagnostic log. The adapter selects the metadata fields
 * explicitly so viewer frames, input, credentials, URLs, and engine details
 * cannot enter the durable representation through structural excess fields.
 */
export class LocalCoreDesktopBrowserViewerEventSink
  implements DesktopBrowserViewerEventSink
{
  readonly #store: DesktopBrowserViewerDiagnosticStore;
  #tail: Promise<void> = Promise.resolve();

  constructor(input: {
    homePath: string;
    store?: DesktopBrowserViewerDiagnosticStore | undefined;
  }) {
    this.#store = input.store ?? new DiagnosticLogStore(input.homePath);
  }

  record(event: DesktopBrowserViewerEventV1): void {
    let entry: DiagnosticLogEntry;
    try {
      entry = desktopBrowserViewerDiagnosticEntry(event);
    } catch {
      return;
    }
    this.#tail = this.#tail
      .then(async () => await this.#store.append(entry))
      .catch(() => undefined);
  }

  /** Waits for accepted records during packaged shutdown and composition tests. */
  async flush(): Promise<void> {
    await this.#tail;
  }
}

export function createLocalCoreDesktopBrowserViewerEventSink(input: {
  homePath: string;
}): LocalCoreDesktopBrowserViewerEventSink {
  return new LocalCoreDesktopBrowserViewerEventSink(input);
}

function desktopBrowserViewerDiagnosticEntry(
  event: DesktopBrowserViewerEventV1,
): DiagnosticLogEntry {
  return {
    scope: DESKTOP_BROWSER_VIEWER_DIAGNOSTIC_SCOPE,
    summary: event.name,
    details: JSON.stringify({
      name: event.name,
      at: event.at,
      sessionId: event.sessionId,
      generation: event.generation,
      threadId: event.threadId,
      projectId: event.projectId,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    }),
  };
}
