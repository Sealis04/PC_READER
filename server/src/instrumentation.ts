// Runs once when the server starts. Event streams do not survive a restart, so any device still
// marked online from the previous process is reset; agents reconnect and flip back to Online.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return;
  try {
    const [{ getDb }, { resetOnlineFlags }] = await Promise.all([import("@/db"), import("@/lib/agent/events")]);
    await resetOnlineFlags(getDb());
  } catch (e) {
    // The database may not be migrated yet on first start; the flags are all false then anyway.
    console.warn("could not reset online flags:", e instanceof Error ? e.message : e);
  }
}
