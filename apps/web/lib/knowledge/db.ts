import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/drizzle/schema";
import { getDrizzleDb } from "@/lib/db/runtime";

type KnowledgeDb = PostgresJsDatabase<typeof schema>;

function getKnowledgeDb(): KnowledgeDb {
  return getDrizzleDb();
}

export const knowledgeDb = new Proxy({} as KnowledgeDb, {
  get(_target, property, receiver) {
    const db = getKnowledgeDb() as unknown as Record<PropertyKey, unknown>;
    const value = Reflect.get(db, property, receiver);
    return typeof value === "function" ? value.bind(db) : value;
  },
});
export { schema };
