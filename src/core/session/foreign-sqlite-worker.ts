import { Database } from "bun:sqlite"
import { safeSessionText } from "./repository.ts"

/** Runs only against a private copy; a parent deadline bounds hostile/expensive SQL schemas. */
export function foreignSqliteMain(path = process.argv[2]): void {
  if (!path) throw new Error("Missing foreign database snapshot")
  const db = new Database(path, { readonly: true, strict: true })
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON")
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 101")
      .all() as Array<{ name: string }>
    const names = tables.slice(0, 100).map((row) => safeSessionText(row.name).slice(0, 128))
    const columns = names.includes("threads")
      ? (db.query("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map((row) => row.name)
      : []
    const valid = ["id", "cwd", "rollout_path"].every((name) => columns.includes(name))
    const rows = valid
      ? (db
          .query(
            `SELECT id, cwd, rollout_path${columns.includes("title") ? ", title" : ""} FROM threads LIMIT 101`,
          )
          .all() as Array<Record<string, unknown>>)
      : []
    process.stdout.write(
      JSON.stringify({
        tables: names,
        schema: valid ? "codex-threads-v1" : "unknown",
        truncated: tables.length > 100 || rows.length > 100,
        rows: rows
          .slice(0, 100)
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                typeof value === "string"
                  ? (key === "title" ? safeSessionText(value) : value).slice(0, 4096)
                  : "",
              ]),
            ),
          ),
      }),
    )
  } finally {
    db.close()
  }
}
if (import.meta.main) foreignSqliteMain()
