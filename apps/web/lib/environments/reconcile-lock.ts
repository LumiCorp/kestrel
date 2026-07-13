import postgres from "postgres";

const ENVIRONMENT_RECONCILE_LOCK_KEY = "kestrel:hosted-environments:reconcile";
const ENVIRONMENT_OPERATION_LOCK_PREFIX =
  "kestrel:hosted-environments:operation";

export type EnvironmentReconcileLock = {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
  close(): Promise<void>;
};

export async function withEnvironmentReconcileLock<T>(input: {
  run: () => Promise<T>;
  createLock?: (lockKey: string) => Promise<EnvironmentReconcileLock>;
}) {
  return withEnvironmentAdvisoryLock({
    ...input,
    lockKey: ENVIRONMENT_RECONCILE_LOCK_KEY,
  });
}

export async function withEnvironmentOperationLock<T>(input: {
  operationId: string;
  run: () => Promise<T>;
  createLock?: (lockKey: string) => Promise<EnvironmentReconcileLock>;
}) {
  const operationId = input.operationId.trim();
  if (!operationId) throw new Error("Environment operation ID is required");
  return withEnvironmentAdvisoryLock({
    createLock: input.createLock,
    lockKey: `${ENVIRONMENT_OPERATION_LOCK_PREFIX}:${operationId}`,
    run: input.run,
  });
}

async function withEnvironmentAdvisoryLock<T>(input: {
  lockKey: string;
  run: () => Promise<T>;
  createLock?: (lockKey: string) => Promise<EnvironmentReconcileLock>;
}) {
  if (!input.createLock) {
    return withPostgresEnvironmentAdvisoryLock(input);
  }
  const lock = await input.createLock(input.lockKey);
  let acquired = false;
  try {
    acquired = await lock.tryAcquire();
    if (!acquired) {
      return { acquired: false as const, result: null };
    }
    return { acquired: true as const, result: await input.run() };
  } finally {
    try {
      if (acquired) await lock.release();
    } finally {
      await lock.close();
    }
  }
}

async function withPostgresEnvironmentAdvisoryLock<T>(input: {
  lockKey: string;
  run: () => Promise<T>;
}) {
  const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required");
  }
  const sql = postgres(databaseUrl, {
    connect_timeout: 10,
    idle_timeout: 20,
    max: 1,
    prepare: false,
  });
  try {
    return await sql.begin(async (transaction) => {
      const [row] = await transaction<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended(${input.lockKey}, 0)
        ) AS "acquired"
      `;
      if (row?.acquired !== true) {
        return { acquired: false as const, result: null };
      }
      return { acquired: true as const, result: await input.run() };
    });
  } finally {
    await sql.end({ timeout: 1 });
  }
}
