import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

let client: postgres.Sql | undefined;
let instance: Db | undefined;

// Lazily connect so importing route modules (e.g. during `next build`) needs no database.
export function getDb(): Db {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    client = postgres(url, { max: 10 });
    instance = drizzle(client, { schema });
  }
  return instance;
}

export async function closeDb(): Promise<void> {
  await client?.end();
  client = undefined;
  instance = undefined;
}
