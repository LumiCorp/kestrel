import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";

export type DesktopHostOpenRequest =
  | { kind: "application"; application: string }
  | { kind: "workspace_path"; targetPath: string; application?: string | undefined }
  | { kind: "url"; url: string; application?: string | undefined };

export interface DesktopHostOpenServicePort {
  open(request: DesktopHostOpenRequest): Promise<void>;
}

type ExecFileLike = (
  file: string,
  args: readonly string[],
) => Promise<unknown>;

const execFileAsync = promisify(execFile);

export class MacOsDesktopHostOpenService implements DesktopHostOpenServicePort {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly execFileImpl: ExecFileLike = async (file, args) =>
      await execFileAsync(file, [...args]),
  ) {}

  async open(request: DesktopHostOpenRequest): Promise<void> {
    if (this.platform !== "darwin") {
      throw createRuntimeFailure(
        "DESKTOP_HOST_OPEN_UNSUPPORTED_PLATFORM",
        "Desktop host opening is currently supported only on macOS.",
        {
          subsystem: "desktop_host",
          classification: "configuration",
          recoverable: false,
        },
      );
    }

    const args = request.kind === "application"
      ? ["-a", request.application]
      : [
          ...(request.application !== undefined ? ["-a", request.application] : []),
          request.kind === "workspace_path" ? request.targetPath : request.url,
        ];
    try {
      await this.execFileImpl("open", args);
    } catch {
      throw createRuntimeFailure(
        "DESKTOP_HOST_OPEN_FAILED",
        "macOS could not open the requested application or target.",
        {
          subsystem: "desktop_host",
          classification: "runtime",
          recoverable: true,
          kind: request.kind,
          ...(request.application !== undefined ? { application: request.application } : {}),
        },
      );
    }
  }
}
