export function listFiles(root: string): Promise<string[]>;
export function assertNoBundledAttachmentWorker(files: string[]): Promise<void>;
export function resolveTracedAttachmentPackage(files: string[]): Promise<string>;
export function runTracedExtractionSmoke(packageIndexPath: string): void;
export function runAttachmentWorkerBuildSmoke(): Promise<void>;
