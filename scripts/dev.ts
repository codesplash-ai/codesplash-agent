/** Run a trusted private copy so tools can edit this checkout without editing their supervisor. */
import { constants } from "node:fs"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const source = fileURLToPath(new URL("..", import.meta.url))
const snapshot = await mkdtemp(join(tmpdir(), "codesplash-dev-"))
try {
  for (const name of ["src", "node_modules", "package.json"]) {
    await cp(join(source, name), join(snapshot, name), {
      recursive: true,
      dereference: true,
      mode: constants.COPYFILE_FICLONE,
    })
  }
  const child = Bun.spawn([process.execPath, join(snapshot, "src", "cli.ts"), ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  // Forward targeted signals too; keep the parent alive until snapshot cleanup.
  const interrupt = () => child.kill("SIGINT")
  const terminate = () => child.kill("SIGTERM")
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  try {
    process.exitCode = await child.exited
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
  }
} finally {
  await rm(snapshot, { recursive: true, force: true })
}
