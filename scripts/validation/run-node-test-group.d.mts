export const SHARED_PROCESS_ISOLATION: "shared-process";

export function partitionTestFiles(
  files: string[],
  workerCount: number,
): string[][];

export function runFailFastShards<T>(
  shards: T[],
  dependencies: {
    run: (shard: T, index: number) => Promise<void>;
    abort: (index: number) => void;
  },
): Promise<void>;

export function runNodeTestGroup(options: {
  files: string[];
  workers: number;
  isolation: string;
  prefix?: string[];
}): Promise<void>;
