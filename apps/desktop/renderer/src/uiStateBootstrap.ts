import type { DesktopUiStateV1 } from "../../src/contracts";

export interface DesktopUiStateBootstrap {
  state: DesktopUiStateV1 | null;
  persistenceEnabled: boolean;
}

/**
 * Persisted Desktop state is optional session context. A compatibility failure
 * must not prevent the user from opening the workspace.
 */
export async function loadDesktopUiState(
  getUiState: () => Promise<DesktopUiStateV1 | null>,
): Promise<DesktopUiStateBootstrap> {
  try {
    return {
      state: await getUiState(),
      persistenceEnabled: true,
    };
  } catch {
    return {
      state: null,
      persistenceEnabled: false,
    };
  }
}
