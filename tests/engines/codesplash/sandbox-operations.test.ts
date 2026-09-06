import { expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../../../src/core/config.ts"
import {
  editPermissionRule,
  parsePermissionEdit,
  ruleConflict,
} from "../../../src/engines/codesplash/permission-editor.ts"
import {
  createPermissionRuntime,
  describePermissionRules,
} from "../../../src/engines/codesplash/permissions.ts"
import { SecretSanitizer } from "../../../src/engines/codesplash/sandbox/env-policy.ts"
import { SandboxLog } from "../../../src/engines/codesplash/sandbox/log.ts"
import { runProcess } from "../../../src/engines/codesplash/sandbox/process.ts"
import { NamedSecrets, type SecretsAdapter } from "../../../src/engines/codesplash/secrets.ts"

test("permission editor preserves unrelated configuration and reloads effective project rules", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codesplash-editor-")),
    userConfigPath = join(cwd, "config.toml")
  const grantsPath = join(cwd, "grants.toml")
  const options = { cwd, trusted: true, userConfigPath, grantsPath }
  try {
    await writeFile(userConfigPath, 'theme="dark"\n[guardian]\nenabled=true\nmaxReviews=2\n')
    await editPermissionRule(parsePermissionEdit("add user ask bash(npm publish)"), options)
    const config = await loadConfig(userConfigPath)
    expect(config.guardian).toMatchObject({ enabled: true, maxReviews: 2 })
    expect(config.theme).toBe("dark")
    const runtime = await createPermissionRuntime({
      cwd,
      workspaceTrusted: true,
      mode: "default",
      configRules: config.permissions,
      grantsPath,
    })
    await editPermissionRule(parsePermissionEdit("add project deny bash(curl *)"), options)
    await runtime.reload?.()
    expect(runtime.decide("bash", { command: "curl https://example.com" }, false).kind).toBe("deny")
    await editPermissionRule(
      parsePermissionEdit("replace project deny bash(curl *) => bash(wget *)"),
      options,
    )
    await runtime.reload?.()
    expect(runtime.decide("bash", { command: "wget https://example.com" }, false).kind).toBe("deny")
    expect(runtime.decide("bash", { command: "curl https://example.com" }, false).kind).not.toBe("deny")
    await editPermissionRule(parsePermissionEdit("delete project deny bash(wget *)"), options)
    await runtime.reload?.()
    expect(runtime.decide("bash", { command: "wget https://example.com" }, false).kind).not.toBe("deny")
    await editPermissionRule(parsePermissionEdit("add grants allow bash(npm test)"), options)
    await runtime.reload?.()
    expect(
      describePermissionRules(runtime).some((r) => r.source === "grants" && r.raw === "bash(npm test)"),
    ).toBe(true)
    await expect(
      editPermissionRule(parsePermissionEdit("add project allow bash"), { ...options, trusted: false }),
    ).rejects.toThrow("Trust")
    expect(() => parsePermissionEdit("add grants deny bash")).toThrow()
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
test("permission conflicts report only definite stronger rules", () => {
  const allow = {
    tool: "bash",
    pattern: "npm test",
    action: "allow" as const,
    source: "user" as const,
    raw: "bash(npm test)",
  }
  const deny = { tool: "bash", action: "deny" as const, source: "project" as const, raw: "bash" }
  expect(ruleConflict(allow, [allow, deny])).toContain("deny bash (project)")
  expect(ruleConflict(deny, [allow, deny])).toBeUndefined()
})
test("keyring failure never falls back to plaintext; only names enter the local index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codesplash-secrets-"))
  const values = new Map<string, string>()
  const adapter: SecretsAdapter = {
    async get({ name }) {
      return values.get(name) ?? null
    },
    async set({ name, value }) {
      values.set(name, value)
    },
    async delete({ name }) {
      return values.delete(name)
    },
  }
  const store = new NamedSecrets(dir, adapter),
    canary = "fixture-keyring-canary"
  try {
    await store.set("BUILD_CREDENTIAL", canary)
    expect(await store.list()).toEqual(["BUILD_CREDENTIAL"])
    expect(await store.get("BUILD_CREDENTIAL")).toBe(canary)
    const index = await readFile(join(dir, "secret-names.json"), "utf8")
    expect(index).not.toContain(canary)
    if (process.platform !== "win32")
      expect((await stat(join(dir, "secret-names.json"))).mode & 0o777).toBe(0o600)
    await store.delete("BUILD_CREDENTIAL")
    expect(await store.list()).toEqual([])
    await expect(store.get("BUILD_CREDENTIAL")).rejects.toThrow("unavailable")
    const failed = new NamedSecrets(join(dir, "failed"), {
      ...adapter,
      async set() {
        throw new Error(canary)
      },
    })
    await expect(failed.set("BUILD_CREDENTIAL", canary)).rejects.toThrow("no plaintext fallback")
    expect(await Bun.file(join(dir, "failed", "secret-names.json")).exists()).toBe(false)
    expect(await readdir(dir)).toEqual(["secret-names.json"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test("secret sanitization covers every chunk boundary, overlap, and single-character values", () => {
  const raw = "prefix abcdefghi xy suffix"
  for (let split = 0; split <= raw.length; split++) {
    const sanitizer = new SecretSanitizer(["abcdef", "defghi", "xy"])
    const output = sanitizer.push(raw.slice(0, split)) + sanitizer.push(raw.slice(split), true)
    expect(output).toBe("prefix [REDACTED] [REDACTED] suffix")
  }
  expect(new SecretSanitizer(["z"]).redact("azb")).toBe("a[REDACTED]b")
})
test("sandbox log retains bounded metadata and no-history creates no log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codesplash-logs-")),
    path = join(dir, "events.jsonl")
  try {
    const none = new SandboxLog()
    none.record("execution", "fixture", "success")
    await none.flush()
    expect(await readdir(dir)).toEqual([])
    await writeFile(path, "x".repeat(1024 * 1024 + 1))
    const log = new SandboxLog(path)
    log.record("execution", "fixture", "success")
    await log.flush()
    expect((await stat(`${path}.1`)).size).toBeGreaterThan(1024 * 1024)
    expect(JSON.parse((await readFile(path, "utf8")).trim())).toMatchObject({
      version: 1,
      kind: "execution",
      profileHash: "fixture",
      outcome: "success",
    })
    const failed = new SandboxLog(join(path, "not-a-directory"))
    failed.record("execution", "fixture", "success")
    await failed.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test("process transport sanitizes before bounding output and preserves signal exit codes", async () => {
  if (process.platform === "win32") return
  const signal = new AbortController().signal,
    canary = "unique-stream-secret"
  const result = await runProcess(
    ["/bin/bash", "-c", "printf '%s' \"$VALUE\"; printf '%6000s' x; printf '%s' \"$VALUE\" >&2"],
    { cwd: tmpdir(), env: { VALUE: canary }, signal, secrets: [canary], maxBytes: 1024 },
  )
  expect(result.exitCode).toBe(0)
  expect(result.stdout + result.stderr).not.toContain(canary)
  expect(result.stdout).toContain("[output truncated]")
  expect(Buffer.byteLength(result.stdout)).toBeLessThan(1100)
  const killed = await runProcess(["/bin/bash", "-c", "kill -TERM $$"], { cwd: tmpdir(), env: {}, signal })
  expect(killed.exitCode).toBe(143)
})
