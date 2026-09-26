import { writeFile } from "node:fs/promises"
import { diagnosticFiles, diagnosticRoot, exportDiagnostics, replayDiagnostics } from "../core/diagnostics.ts"
import { bytes } from "../core/session/files.ts"
import { UsageError } from "./usage-error.ts"

export async function runDiagnosticsCommand(command: string, args: string[]): Promise<number> {
  if (args[0] === "--help") {
    process.stdout.write(
      "codesplash diagnostics [status|crashes]\ncodesplash trace export FILE | replay FILE\ncodesplash feedback export FILE | send FILE --url HTTPS_URL --yes\n",
    )
    return 0
  }
  const [action, path, ...rest] = args
  if (command === "diagnostics" && (!action || ["status", "crashes"].includes(action)) && !path) {
    const data = exportDiagnostics()
    process.stdout.write(
      JSON.stringify(
        action === "crashes"
          ? data.records.filter((record) => ["app.crash", "app.recovered"].includes(record.kind))
          : { files: diagnosticFiles().length, ...replayDiagnostics(data) },
        null,
        2,
      ) + "\n",
    )
    return 0
  }
  if (["trace", "feedback"].includes(command) && action === "export" && path && !rest.length) {
    const data = JSON.stringify(exportDiagnostics(diagnosticRoot()), null, 2)
    await writeFile(path, data, { flag: "wx", mode: 0o600 })
    process.stdout.write("Content-free diagnostics exported. Review the file before sharing.\n")
    return 0
  }
  if (command === "trace" && action === "replay" && path && !rest.length) {
    process.stdout.write(
      JSON.stringify(replayDiagnostics(JSON.parse(bytes(path, 16 * 1024 * 1024).toString())), null, 2) + "\n",
    )
    return 0
  }
  if (
    command === "feedback" &&
    action === "send" &&
    path &&
    rest.length === 3 &&
    rest[0] === "--url" &&
    rest[2] === "--yes"
  ) {
    const url = new URL(rest[1]!)
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search)
      throw new UsageError("Feedback requires an HTTPS destination without credentials, query or fragment")
    if (process.env.CODESPLASH_OFFLINE === "1" || process.env.CODESPLASH_FEEDBACK_DISABLED === "1")
      throw new Error("Feedback upload disabled")
    const data = JSON.parse(bytes(path, 16 * 1024 * 1024).toString())
    replayDiagnostics(data)
    // Re-project on upload: a user-edited export cannot smuggle arbitrary fields into feedback.
    const { cleanRecord } = await import("../core/diagnostics.ts")
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ version: 1, records: data.records.map(cleanRecord) }),
      headers: { "content-type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    })
    await response.body?.cancel()
    if (!response.ok)
      throw new Error(`Feedback endpoint returned HTTP ${response.status}; upload was not retried`)
    process.stdout.write("Diagnostic report sent.\n")
    return 0
  }
  throw new UsageError("Use diagnostics --help for diagnostic, trace and feedback commands")
}
