/** Exercise offline management, executable trust and real stdio discovery from the release. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const argument = process.argv[2]
if (!argument) throw new Error("Usage: bun scripts/mcp-smoke.ts /path/to/codesplash")
const binary = resolve(argument)
const root = await realpath(await mkdtemp(join(tmpdir(), "codesplash-mcp-smoke-")))
try {
  const cwd = join(root, "workspace"),
    config = join(root, "config"),
    script = join(cwd, "fixture.sh")
  await mkdir(cwd)
  await mkdir(config)
  await writeFile(
    script,
    String.raw`while IFS= read -r line; do
  id=$(printf '%s' "$line" | /usr/bin/sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  case "$line" in
    *'"method":"initialize"'*) result='{"protocolVersion":"2025-11-25","serverInfo":{"name":"release-fixture","version":"1"},"capabilities":{"tools":{}}}' ;;
    *) result='{"tools":[{"name":"fixture","inputSchema":{"type":"object"}}]}' ;;
  esac
  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$id" "$result"
done
`,
  )
  const env = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: join(root, "data"),
  }
  for (const key of ["CODESPLASH_CONFIG", "CODESPLASH_PROFILE", "CODESPLASH_PERMISSION_MODE"])
    delete (env as NodeJS.ProcessEnv)[key]
  const run = async (args: string[], okay = true) => {
    const result = await runProcess(
      [...(binary.endsWith(".js") ? [process.execPath, binary] : [binary]), "mcp", ...args],
      {
        cwd,
        env,
        signal: new AbortController().signal,
        timeoutMs: 30_000,
        maxBytes: 1024 * 1024,
        structured: true,
      },
    )
    assert.equal(result.exitCode === 0, okay, `${result.stdout}\n${result.stderr}`)
    return okay ? JSON.parse(result.stdout) : undefined
  }
  await run(["add", "fixture", "--", "/bin/sh", script])
  assert.equal((await run(["list"])).servers[0].enabled, false)
  await run(["doctor", "fixture", "--connect"], false)
  await run(["enable", "fixture"])
  const review = await run(["show", "fixture"])
  assert.equal(review.trusted, false)
  await run(["trust", "fixture", "--fingerprint", review.fingerprint])
  const connected = await run(["doctor", "fixture", "--connect"])
  assert.equal(connected.servers[0].state, "ready")
  assert.equal(connected.servers[0].tools, 1)
  await writeFile(script, "exit 1\n")
  assert.equal((await run(["show", "fixture"])).trusted, false)
  await run(["doctor", "fixture", "--connect"], false)
  await run(["remove", "fixture"])
  assert.deepEqual((await run(["list"])).servers, [])
  console.log(
    "Compiled MCP management/stdio smoke passed: inert add, explicit trust, sandboxed discovery, changed-source refusal and close",
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
