import { dataDirectory, loadConfig } from "../core/config.ts"
import { git } from "../core/orchestration/git.ts"
import { WorktreeStore } from "../core/orchestration/worktrees.ts"
import { importPortable } from "../core/session/portable.ts"
import { SessionStore } from "../core/sessions.ts"
import { readTrustDecision } from "../core/trust.ts"
import { createPermissionRuntime } from "../engines/codesplash/permissions.ts"
import { runProcess } from "../engines/codesplash/sandbox/process.ts"
import { fetchShare } from "../server/sharing.ts"
import { UsageError } from "./usage-error.ts"

export function pullRequestReference(value: string) {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(value)
  if (!match) throw new UsageError("Use a full https://github.com/OWNER/REPO/pull/NUMBER URL")
  return { repository: match[1]!, number: Number(match[2]) }
}
export async function runPrCommand(args: string[]) {
  const [source, ...flags] = args
  if (!source || flags.some((v) => !["--apply", "--trust", "--import-session"].includes(v)))
    throw new UsageError("codesplash pr URL [--apply] [--trust] [--import-session]")
  const pr = pullRequestReference(source),
    binary = Bun.which("gh")
  if (!binary) throw new Error("GitHub CLI (gh) is required for PR metadata and authentication")
  const metadataResult = await runProcess([binary, "pr", "view", source, "--json", "headRefOid,body,url"], {
    cwd: process.cwd(),
    env: process.env,
    signal: AbortSignal.timeout(15000),
    timeoutMs: 15000,
    maxBytes: 1024 * 1024,
    structured: true,
  })
  if (metadataResult.kind !== "success") throw new Error("Cannot read bounded PR metadata")
  const metadata = JSON.parse(metadataResult.stdout) as { headRefOid: string; body: string; url: string }
  if (
    !/^[a-f0-9]{40}$/.test(metadata.headRefOid) ||
    metadata.url !== source.replace(/\/$/, "") ||
    typeof metadata.body !== "string"
  )
    throw new Error("Unexpected PR metadata")
  const links = [
    ...new Set(metadata.body.match(/https:\/\/[^\s<>"')]+\/share\/[\w-]{43}(?:\/bundle)?/g) ?? []),
  ]
  if (!flags.includes("--apply")) {
    process.stdout.write(
      `${JSON.stringify({ ...pr, commit: metadata.headRefOid, linkedSessions: links, action: "Creates a managed isolated checkout; add --apply after reviewing the PR and --trust for the local repository" }, null, 2)}\n`,
    )
    return 0
  }
  const cwd = process.cwd(),
    data = dataDirectory(),
    trusted = flags.includes("--trust") || (await readTrustDecision(cwd, data))?.trusted === true
  if (!trusted) throw new Error("PR checkout requires local workspace trust (--trust)")
  const config = await loadConfig(undefined, [], { cwd, workspaceTrusted: trusted, dataDir: data })
  if (config.permissions.mode === "plan" || config.codex.sandbox === "read-only" || !config.history.enabled)
    throw new Error("PR checkout is denied by configuration")
  const permissions = await createPermissionRuntime({
    cwd,
    workspaceTrusted: trusted,
    mode: config.permissions.mode,
    configRules: config.permissions,
    constraints: config.resolution?.constraints,
  })
  if (permissions.decide("worktree", undefined, false).kind === "deny")
    throw new Error("PR worktree denied by policy")
  const tokenProcess = Bun.spawn([binary, "auth", "token", "--hostname", "github.com"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  const timer = setTimeout(() => tokenProcess.kill("SIGKILL"), 10000)
  let token = ""
  try {
    const reader = tokenProcess.stdout.getReader()
    while (true) {
      const result = await reader.read()
      if (result.done) break
      token += Buffer.from(result.value).toString()
      if (token.length > 16384) {
        tokenProcess.kill("SIGKILL")
        throw new Error("Invalid GitHub credential response")
      }
    }
    if ((await tokenProcess.exited) !== 0) token = ""
    token = token.trim()
  } finally {
    clearTimeout(timer)
  }
  const auth: Record<string, string> = token
    ? {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      }
    : {}
  await git(
    cwd,
    [
      "-c",
      "credential.helper=",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      `https://github.com/${pr.repository}.git`,
      `pull/${pr.number}/head`,
    ],
    undefined,
    auth,
  )
  if ((await git(cwd, ["rev-parse", "FETCH_HEAD"])).toString().trim() !== metadata.headRefOid)
    throw new Error("PR changed during checkout; review it again")
  const store = await WorktreeStore.open(cwd, data, {
    readable: (path) => !permissions.isReadDenied(path, "read_file"),
    writable: (path) => permissions.decide("write_file", { paths: [path] }, false).kind !== "deny",
  })
  const tree = await store.create(metadata.headRefOid)
  let imported: unknown
  if (flags.includes("--import-session")) {
    if (links.length !== 1)
      throw new Error(
        "Expected exactly one session link; checkout retained, import the chosen URL explicitly",
      )
    const bundle = await fetchShare(links[0]!)
    imported = await importPortable(new SessionStore().root, bundle, tree.cwd, true)
  }
  process.stdout.write(`${JSON.stringify({ ...pr, checkout: tree, imported }, null, 2)}\n`)
  return 0
}
