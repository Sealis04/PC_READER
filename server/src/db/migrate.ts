import { migrate } from "drizzle-orm/postgres-js/migrator";
import { join } from "node:path";
import { closeDb, getDb } from "./index";

export const migrationsFolder = join(import.meta.dir, "..", "..", "drizzle");

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder });
}

if (import.meta.main) {
  await runMigrations();
  await closeDb();
  console.log("migrations applied");
}
