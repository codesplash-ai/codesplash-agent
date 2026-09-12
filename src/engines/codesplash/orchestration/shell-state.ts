import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { redactSensitiveText } from "../../../core/redaction.ts"
import { atomic, bytes, digest, hostPath, json, lease } from "../../../core/session/files.ts"
import { validateEnvironmentName } from "../sandbox/env-policy.ts"
import { shellQuote } from "../sandbox/supervisor.ts"

export type ShellSnapshot = {
  version: 1
  shell: "bash" | "zsh"
  environment: Record<string, string>
  definitions: string
}
export type ShellSelection = { path: string; fingerprint: string }
function validate(value: unknown, env = process.env): ShellSnapshot {
  const snapshot = value as ShellSnapshot
  if (
    !snapshot ||
    snapshot.version !== 1 ||
    !["bash", "zsh"].includes(snapshot.shell) ||
    typeof snapshot.definitions !== "string" ||
    Buffer.byteLength(snapshot.definitions) > 65536 ||
    !snapshot.environment ||
    typeof snapshot.environment !== "object" ||
    Array.isArray(snapshot.environment) ||
    Object.keys(snapshot.environment).length > 64 ||
    Object.keys(snapshot).some((k) => !["version", "shell", "environment", "definitions"].includes(k))
  )
    throw new Error("Invalid shell snapshot")
  for (const [name, value] of Object.entries(snapshot.environment)) {
    validateEnvironmentName(name)
    if (
      typeof value !== "string" ||
      value.length > 4096 ||
      value.includes("\0") ||
      redactSensitiveText(value, env) !== value
    )
      throw new Error("Shell snapshot contains an invalid or secret environment value")
  }
  if (
    snapshot.definitions.includes("\0") ||
    redactSensitiveText(snapshot.definitions, env) !== snapshot.definitions
  )
    throw new Error("Shell definitions contain credential-shaped content")
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 128 * 1024)
    throw new Error("Shell snapshot exceeds 128 KiB")
  return snapshot
}
export function captureShellSnapshot(
  path: string,
  shell: "bash" | "zsh",
  names: string[],
  definitionsPath?: string,
  env = process.env,
) {
  if (names.length > 64 || new Set(names).size !== names.length)
    throw new Error("Select at most 64 unique environment names")
  const environment: Record<string, string> = {}
  for (const name of names) {
    validateEnvironmentName(name)
    if (env[name] !== undefined) environment[name] = env[name]!
  }
  const definitions = definitionsPath ? bytes(definitionsPath, 65536).toString("utf8") : ""
  const snapshot = validate({ version: 1, shell, environment, definitions }, env)
  path = hostPath(path)
  const release = lease(dirname(path), "shell-capture.lease")
  try {
    writeFileSync(path, JSON.stringify(snapshot, null, 2), { flag: "wx", mode: 0o600 })
  } finally {
    release()
  }
  return reviewShellSnapshot(path, env)
}
export function reviewShellSnapshot(path: string, env = process.env) {
  path = hostPath(path)
  const source = bytes(path, 128 * 1024)
  const snapshot = validate(JSON.parse(source.toString("utf8")), env)
  return { path, fingerprint: digest(source), snapshot }
}
const receiptPath = (dataDir: string, path: string) =>
  join(dataDir, "shell-trust", `${digest(hostPath(path))}.json`)
export function trustShellSnapshot(dataDir: string, selection: ShellSelection) {
  const review = reviewShellSnapshot(selection.path)
  if (review.fingerprint !== selection.fingerprint)
    throw new Error("Shell snapshot changed; review its current fingerprint")
  const release = lease(join(dataDir, "shell-trust"), "edit.lease")
  try {
    atomic(receiptPath(dataDir, review.path), JSON.stringify({ version: 1, fingerprint: review.fingerprint }))
  } finally {
    release()
  }
  return review
}
export function shellSnapshotArgv(dataDir: string, selection: ShellSelection, command: string): string[] {
  const review = reviewShellSnapshot(selection.path)
  const receipt = json<{ version: number; fingerprint: string }>(receiptPath(dataDir, review.path), 4096)
  if (
    receipt.version !== 1 ||
    receipt.fingerprint !== review.fingerprint ||
    selection.fingerprint !== review.fingerprint
  )
    throw new Error("Shell snapshot is untrusted or changed")
  const { shell, definitions, environment } = review.snapshot
  const source = [
    shell === "bash" ? "shopt -s expand_aliases" : "",
    ...Object.entries(environment).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    definitions,
    command,
  ].join("\n")
  if (Buffer.byteLength(source) > 65536) throw new Error("Combined shell snapshot and command exceed 64 KiB")
  return shell === "bash"
    ? ["/bin/bash", "--noprofile", "--norc", "-c", source]
    : ["/bin/zsh", "-f", "-c", source]
}
