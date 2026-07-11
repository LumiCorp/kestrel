import { Kysely, PostgresDialect } from "kysely";
import type { Pool } from "pg";
import { getKyselyDb, getPgPool } from "./db/runtime";

function getPool(): Pool {
  return getPgPool();
}

export const pool = new Proxy({} as Pool, {
  get(_target, property, receiver) {
    const instance = getPool() as unknown as Record<PropertyKey, unknown>;
    const value = Reflect.get(instance, property, receiver);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

const dialect = new PostgresDialect({ pool });

export const dbClient = new Proxy(new Kysely<any>({ dialect }) as Kysely<any>, {
  get(_target, property, receiver) {
    const client = getKyselyDb() as unknown as Record<PropertyKey, unknown>;
    const value = Reflect.get(client, property, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
