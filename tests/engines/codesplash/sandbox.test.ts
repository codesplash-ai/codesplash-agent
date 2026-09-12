import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionRuntime } from "../../../src/engines/codesplash/permissions.ts"
import { childEnvironment, SecretSanitizer } from "../../../src/engines/codesplash/sandbox/env-policy.ts"
import { hardenLinuxMounts } from "../../../src/engines/codesplash/sandbox/linux-mounts.ts"
import {
  canonicalHost,
  createProfile,
  physicalPath,
  pinProfile,
  validateAccessGrant,
} from "../../../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../../../src/engines/codesplash/sandbox/runtime.ts"
import { writeFileTool } from "../../../src/engines/codesplash/tools/write.ts"

describe("native sandbox contracts", () => {
  test("Linux configuration masks retain directory shape when another owner creates the mountpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesplash-mount-race-"))
    const config = join(root, ".codesplash")
    const sentinel = join(root, "denied")
    const wrapper = [
      "bwrap",
      "--ro-bind",
      "/",
      "/",
      "--bind",
      root,
      root,
      "--ro-bind",
      "/dev/null",
      config,
      "--",
      "/bin/sh",
      "-c",
      'test -d "$1" && ! touch "$1/blocked" && printf protected',
      "probe",
      config,
    ]
    const policy = { allowWrite: [root], denyWrite: [config] }
    try {
      await writeFile(sentinel, "")
      const absent = hardenLinuxMounts(wrapper, policy, sentinel)
      await mkdir(config)
      const appeared = hardenLinuxMounts(wrapper, policy, sentinel)
      for (const argv of [absent, appeared]) {
        const source = argv[argv.indexOf(config) - 1]!
        expect((await stat(source)).isDirectory()).toBe(true)
        if (process.platform === "linux") {
          const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
          const [out, err, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ])
          expect(code, err).toBe(0)
          expect(out).toBe("protected")
          expect(await Bun.file(join(config, "blocked")).exists()).toBe(false)
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("filters credentials and shell startup injection without altering parent env", () => {
    const source = {
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      API_KEY: "secret1234",
      BASH_ENV: "/evil",
      NODE_OPTIONS: "--require=evil",
      BUILD_MODE: "release",
    }
    const env = childEnvironment("/private/tmp/isolated", ["BUILD_MODE"], source)
    expect(env.API_KEY).toBeUndefined()
    expect(env.BASH_ENV).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.BUILD_MODE).toBe("release")
    expect(source.API_KEY).toBe("secret1234")
    expect(() => childEnvironment("/tmp", ["BASH_ENV"], source)).toThrow()
  })
  test("sanitizes split and overlapping secrets", () => {
    const sanitizer = new SecretSanitizer(["abcdef", "defghi", "xy"])
    const output = sanitizer.push("before abc") + sanitizer.push("defgh") + sanitizer.push("i xy after", true)
    expect(output).toBe("before [REDACTED] [REDACTED] after")
  })
  test("host grants are exact canonical DNS endpoints", () => {
    expect(canonicalHost("EXAMPLE.COM.:443")).toBe("example.com:443")
    for (const value of [
      "*.example.com:443",
      "127.0.0.1:80",
      "localhost:80",
      "example.com:0",
      "https://example.com",
    ])
      expect(() => canonicalHost(value)).toThrow()
  })
  test("profiles pin and refuse changed policy and corrupt versions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codesplash-profile-test-"))
    try {
      const p = createProfile(dir, "workspace-write")
      const path = join(dir, "profile.json")
      expect((await pinProfile(p, path)).hash).toBe(p.hash)
      await expect(pinProfile(createProfile(dir, "read-only"), path)).rejects.toThrow("conflicts")
      await writeFile(path, JSON.stringify({ ...p, version: 99 }))
      await expect(pinProfile(p, path)).rejects.toThrow("Unsupported")
      expect(() =>
        validateAccessGrant(p, { resource: "write", target: "/", scope: "session" }, false),
      ).toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!["darwin", "linux"].includes(process.platform))("native OS enforcement", () => {
  test("real backend allows project writes, blocks external writes and runs file tools", async () => {
    const parent = physicalPath(await mkdtemp(join(tmpdir(), "codesplash-os-test-")))
    const workspace = join(parent, "workspace")
    const { mkdir } = await import("node:fs/promises")
    await mkdir(workspace)
    const runtime = new NativeSandbox(createProfile(workspace, "workspace-write"))
    try {
      const signal = new AbortController().signal
      const good = await runtime.execute(["/bin/sh", "-c", "printf hello > allowed.txt"], signal)
      expect(good, JSON.stringify(good)).toMatchObject({ kind: "success", exitCode: 0 })
      expect(await readFile(join(workspace, "allowed.txt"), "utf8")).toBe("hello")
      const bad = await runtime.execute(["/bin/sh", "-c", "printf escaped > ../forbidden.txt"], signal)
      expect(bad.exitCode).not.toBe(0)
      expect(await Bun.file(join(parent, "forbidden.txt")).exists()).toBe(false)
      const permissions = await createPermissionRuntime({
        cwd: workspace,
        mode: "default",
        workspaceTrusted: false,
        configRules: { allow: [], ask: [], deny: [] },
      })
      const file = await runtime.runTool(
        writeFileTool,
        { path: "tool.txt", content: "worker" },
        {
          cwd: workspace,
          signal,
          permissions,
          policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
        },
      )
      expect(file, JSON.stringify(file)).not.toHaveProperty("isError", true)
      expect(await readFile(join(workspace, "tool.txt"), "utf8")).toBe("worker")
    } finally {
      await runtime.close()
      await rm(parent, { recursive: true, force: true })
    }
  }, 60_000)
})
