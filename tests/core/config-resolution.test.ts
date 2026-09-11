import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extractConfigControls, parseAppArguments, parseRunArguments } from "../../src/cli.ts"
import { runConfigCommand } from "../../src/commands/config.ts"
import { defaultAppOptions, effectiveSessionPolicy } from "../../src/core/app-options.ts"
import { resolveConfig, resolveConfigForWorkspace } from "../../src/core/config/resolver.ts"
import { editConfigSource, readConfigSource } from "../../src/core/config/source.ts"
import { applyConfigOverrides, loadConfig } from "../../src/core/config.ts"
import { editPermissionRule } from "../../src/engines/codesplash/permission-editor.ts"
import { createPermissionRuntime } from "../../src/engines/codesplash/permissions.ts"
import { createProfile } from "../../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../../src/engines/codesplash/sandbox/runtime.ts"
import { builtinTools, createToolRegistry } from "../../src/engines/codesplash/tools/registry.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(user = "", project = "", managed = "") {
  const root = mkdtempSync(join(tmpdir(), "cs-config-"))
  roots.push(root)
  const cwd = join(root, "workspace"),
    path = join(root, "config.toml")
  mkdirSync(join(cwd, ".codesplash"), { recursive: true })
  writeFileSync(path, user)
  writeFileSync(join(cwd, ".codesplash", "config.toml"), project)
  writeFileSync(join(root, "managed.toml"), managed)
  const options = { cwd, env: {}, workspaceTrusted: true, dataDir: join(root, "data") }
  return { root, cwd, path, options }
}

describe("layered configuration", () => {
  test("inline JSON/TOML environment overlays obey a closed field allowlist", async () => {
    const f = fixture()
    for (const inline of [
      'theme="dark"\n[permissions]\nmode="plan"',
      '{"theme":"dark","permissions":{"mode":"plan"}}',
    ]) {
      const config = await resolveConfig(f.path, [], { ...f.options, env: { CODESPLASH_CONFIG: inline } })
      expect(config.theme).toBe("dark")
      expect(config.permissions.mode).toBe("plan")
    }
    await expect(
      resolveConfig(f.path, [], {
        ...f.options,
        env: { CODESPLASH_CONFIG: '{"sandbox":{"allowedHosts":["evil.test:443"]}}' },
      }),
    ).rejects.toThrow("allowlist")
  })
  test("precedence and provenance include shadowed contributions without their values", async () => {
    const f = fixture('theme="light"\n[profiles.work]\ntheme="dark"', 'theme="system"')
    const config = await resolveConfig(f.path, ['theme="dark"'], {
      ...f.options,
      profile: "work",
      env: { CODESPLASH_THEME: "light", UNRELATED: "ignored" },
    })
    expect(config.theme).toBe("dark")
    expect(config.resolution?.provenance.theme).toEqual([
      "defaults",
      "user",
      "project",
      "profile:user:work",
      "environment",
      "cli",
    ])
    expect(config.resolution?.generation).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(config.resolution?.request)).not.toContain("UNRELATED")
  })
  test("untrusted project content is never parsed or inherited", async () => {
    const f = fixture('theme="dark"', "invalid TOML [[[ secret")
    const config = await resolveConfig(f.path, [], { ...f.options, workspaceTrusted: false })
    expect(config.theme).toBe("dark")
    expect(config.resolution?.sources.find((s) => s.scope === "project")?.disabledReason).toContain(
      "not trusted",
    )
  })
  test("trusted project symlinks cannot escape the workspace", async () => {
    const f = fixture()
    rmSync(join(f.cwd, ".codesplash"), { recursive: true })
    symlinkSync(f.root, join(f.cwd, ".codesplash"))
    await expect(resolveConfig(f.path, [], f.options)).rejects.toThrow("Could not read")
  })
  test("profiles inherit in order and cycles in unselected definitions fail", async () => {
    const f = fixture(
      'profile="work"\n[profiles.base]\ntheme="dark"\n[profiles.work]\nextends="base"\n[profiles.work.history]\nenabled=false',
    )
    const config = await resolveConfig(f.path, [], f.options)
    expect(config.theme).toBe("dark")
    expect(config.history.enabled).toBe(false)
    writeFileSync(f.path, '[profiles.a]\nextends="b"\n[profiles.b]\nextends="a"')
    await expect(resolveConfig(f.path, [], f.options)).rejects.toThrow("cycle")
  })
  test("arrays replace grants while restrictions accumulate", async () => {
    const f = fixture(
      '[permissions]\nallow=["read"]\ndeny=["bash"]\nask=["edit"]',
      '[permissions]\nallow=[]\ndeny=[]\nask=["write"]',
    )
    const config = await resolveConfig(f.path, ['permissions.deny=["fetch"]'], f.options)
    expect(config.permissions.allow).toEqual([])
    expect(config.permissions.deny).toEqual(["bash", "fetch"])
    expect(config.permissions.ask).toEqual(["edit", "write"])
  })
  test("strict validation checks unknown nested fields even in unselected profiles", async () => {
    const f = fixture("[profiles.work.history]\nenabeld=false")
    expect((await resolveConfig(f.path, [], f.options)).resolution?.diagnostics[0]).toContain("enabeld")
    await expect(resolveConfig(f.path, [], { ...f.options, strict: true })).rejects.toThrow("enabeld")
  })
  test("an invalid lower layer cannot be hidden by a valid override", async () => {
    const f = fixture("theme=12")
    await expect(resolveConfig(f.path, ['theme="dark"'], f.options)).rejects.toThrow("unsupported value")
  })
  test("prototype keys and oversized override depth are rejected", () => {
    for (const value of ["__proto__.polluted=true", "theme.constructor.x=1", `${"x.".repeat(33)}y=1`])
      expect(() => applyConfigOverrides({}, [value])).toThrow("Unsafe configuration key")
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
  test("fresh cwd resolution does not retain the old project's settings", async () => {
    const f = fixture('theme="light"', 'theme="dark"')
    const first = await resolveConfig(f.path, [], f.options)
    const next = join(f.root, "next")
    mkdirSync(next)
    const second = await resolveConfigForWorkspace(first, next, true)
    expect(second.theme).toBe("light")
    expect(second.resolution?.generation).not.toBe(first.resolution?.generation)
  })
})

describe("managed policy", () => {
  test("CLI full-access and bypass cannot exceed managed modes", async () => {
    const f = fixture("", "", 'sandboxModes=["workspace-write"]\npermissionModes=["default"]\ndeny=["bash"]')
    const config = await resolveConfig(f.path, [], f.options)
    expect(config.permissions.deny).toContain("bash")
    expect(() => effectiveSessionPolicy(config, { ...defaultAppOptions, fullAccess: true })).toThrow(
      "managed",
    )
    expect(() => effectiveSessionPolicy(config, { ...defaultAppOptions, bypassApprovals: true })).toThrow(
      "managed",
    )
    const permissions = await createPermissionRuntime({
      cwd: f.cwd,
      mode: "default",
      workspaceTrusted: true,
      configRules: config.permissions,
      constraints: config.resolution?.constraints,
    })
    expect(() => permissions.setMode("accept-edits")).toThrow("managed")
  })
  test("required modes apply after overlays and are rechecked after flags", async () => {
    const f = fixture("", "", '[required.codex]\nsandbox="read-only"\n[required.permissions]\nmode="plan"')
    const config = await resolveConfig(f.path, ["permissions.mode=default"], f.options)
    expect(config.permissions.mode).toBe("plan")
    expect(() =>
      effectiveSessionPolicy(config, { ...defaultAppOptions, sandboxOverride: "workspace-write" }),
    ).toThrow("managed")
  })
  test("network grants cannot escape the managed host list", async () => {
    const f = fixture(
      '[sandbox]\nallowedHosts=["example.com:443", "denied.test:443"]',
      "",
      'allowedHosts=["example.com:443"]',
    )
    const config = await resolveConfig(f.path, [], f.options)
    expect(config.sandbox?.allowedHosts).toEqual(["example.com:443"])
    const sandbox = new NativeSandbox(
      createProfile(f.cwd, "workspace-write", config.sandbox),
      undefined,
      undefined,
      config.resolution?.constraints,
    )
    try {
      const grant = { resource: "network" as const, target: "denied.test:443", scope: "turn" as const }
      expect(() => sandbox.validateGrant(grant, "default")).toThrow("managed")
      expect(() => sandbox.grant(grant)).toThrow("managed")
    } finally {
      await sandbox.close()
    }
  })
  test("unknown managed fields fail closed", async () => {
    const f = fixture("", "", "allowEverything=true")
    await expect(resolveConfig(f.path, [], f.options)).rejects.toThrow("Unknown managed")
  })
})

describe("configuration writes and CLI", () => {
  test("stale tool selections cannot silently bind a replacement runtime", () => {
    const registry = createToolRegistry(builtinTools(), "generation-two")
    expect(() => registry.get("read_file", "generation-one")).toThrow("stale")
    expect(registry.get("read_file", "generation-two")).toBeDefined()
    expect(registry.source("read_file")).toEqual({ id: "builtin", generation: "generation-two" })
  })
  test("a source edit preserves profiles, unknown fields and empty arrays with a backup", async () => {
    const f = fixture('# original\n[profiles.work]\ntheme="dark"\n[future]\nthings=[]')
    const before = readConfigSource(f.path)
    editConfigSource(
      f.path,
      (raw) => {
        raw.theme = "light"
      },
      before.fingerprint,
    )
    const after = readConfigSource(f.path)
    expect(after.raw.profiles).toEqual(before.raw.profiles)
    expect(after.raw.future).toEqual({ things: [] })
    expect(readFileSync(`${f.path}.backup`, "utf8")).toBe(before.source)
    expect(statSync(f.path).mode & 0o777).toBe(0o600)
    expect(() => editConfigSource(f.path, () => {}, before.fingerprint)).toThrow("changed since review")
    expect((await loadConfig(f.path)).theme).toBe("light")
  })
  test("permission edits preserve unknown tables and profile policies", async () => {
    const f = fixture('[future]\nvalue="preserved"\n[profiles.work.permissions]\ndeny=["bash"]')
    await editPermissionRule(
      { source: "user", operation: "add", action: "allow", rule: "read" },
      { cwd: f.cwd, trusted: true, userConfigPath: f.path },
    )
    expect(readConfigSource(f.path).raw.future).toEqual({ value: "preserved" })
    expect(readConfigSource(f.path).raw.profiles).toEqual({ work: { permissions: { deny: ["bash"] } } })
  })
  test("CLI controls remain separate from dotted overrides", () => {
    expect(parseAppArguments(["--profile", "work", "--strict-config"]).options).toMatchObject({
      profile: "work",
      strictConfig: true,
    })
    expect(parseRunArguments(["--profile=work", "--strict-config", "hello"])).toMatchObject({
      profile: "work",
      strictConfig: true,
      prompt: "hello",
    })
    expect(extractConfigControls(["--", "--profile", "work"])).toEqual({ args: ["--", "--profile", "work"] })
  })
  test("profile list includes unselected definitions and explain omits environment", async () => {
    const f = fixture('[profiles.work]\ntheme="dark"\n[profiles.other]\ntheme="light"')
    const env = {
      CODESPLASH_AGENT_CONFIG_DIR: f.root,
      CODESPLASH_AGENT_DATA_DIR: join(f.root, "data"),
      PRIVATE_KEY: "fixture-secret",
    }
    let text = ""
    await runConfigCommand(["profile", "list", "--path", f.cwd], {
      env,
      output: (value) => {
        text += value
      },
    })
    expect(JSON.parse(text).profiles).toEqual(["other", "work"])
    text = ""
    await runConfigCommand(["explain", "--path", f.cwd], {
      env,
      output: (value) => {
        text += value
      },
    })
    expect(text).not.toContain("fixture-secret")
    expect(text).not.toContain('"request"')
  })
})
