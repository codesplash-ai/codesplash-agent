import { describe, expect, test } from "bun:test"
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseSandboxArguments } from "../../../src/commands/sandbox.ts"
import type { PermissionMode } from "../../../src/core/config.ts"
import { createPermissionRuntime } from "../../../src/engines/codesplash/permissions.ts"
import { startNetworkBroker } from "../../../src/engines/codesplash/sandbox/network-broker.ts"
import { createProfile, physicalPath } from "../../../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../../../src/engines/codesplash/sandbox/runtime.ts"
import { NamedSecrets } from "../../../src/engines/codesplash/secrets.ts"
import { bashTool } from "../../../src/engines/codesplash/tools/bash.ts"
import { grepTool } from "../../../src/engines/codesplash/tools/grep.ts"
import { readFileTool } from "../../../src/engines/codesplash/tools/read.ts"
import { createWebFetchTool } from "../../../src/engines/codesplash/tools/web-fetch.ts"
import { createWebSearchTool } from "../../../src/engines/codesplash/tools/web-search.ts"
import { writeFileTool } from "../../../src/engines/codesplash/tools/write.ts"

async function fixture(mode: "read-only" | "workspace-write" = "workspace-write") {
  const parent = physicalPath(await mkdtemp(join(tmpdir(), "codesplash-security-"))),
    cwd = join(parent, "project")
  await mkdir(cwd)
  const runtime = new NativeSandbox(createProfile(cwd, mode))
  const signal = new AbortController().signal
  const probe = await runtime.execute(["/bin/echo", "ready"], signal)
  expect(probe, JSON.stringify(probe)).toMatchObject({ kind: "success", exitCode: 0 })
  const context = async (permissionMode: PermissionMode = "default") => ({
    cwd,
    signal,
    policy: { sandbox: mode, approvalPolicy: "on-request" as const },
    permissions: await createPermissionRuntime({
      cwd,
      mode: permissionMode,
      workspaceTrusted: false,
      configRules: { allow: [], ask: [], deny: [] },
    }),
  })
  return {
    parent,
    cwd,
    runtime,
    signal,
    context,
    async close() {
      await runtime.close()
      await rm(parent, { recursive: true, force: true })
    },
  }
}

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "sandbox security on the real host backend",
  () => {
    test("blocks .git, .codesplash policy changes, symlink escapes and sensitive reads", async () => {
      const f = await fixture()
      try {
        await mkdir(join(f.cwd, ".git"))
        await mkdir(join(f.cwd, ".codesplash"))
        await writeFile(join(f.cwd, ".env"), "SECRET_CANARY")
        await writeFile(join(f.cwd, "private.pem"), "PEM_CANARY")
        await writeFile(join(f.cwd, "id_ed25519"), "SSH_CANARY")
        await symlink(join(f.cwd, ".env"), join(f.cwd, "alias"))
        await symlink(f.parent, join(f.cwd, "escape"))
        const ready = await f.runtime.execute(["/bin/echo", "ready"], f.signal)
        expect(ready, JSON.stringify(ready)).toMatchObject({ kind: "success", stdout: "ready\n" })
        for (const command of [
          "echo bad > .git/config",
          "echo bad > .codesplash/permissions.toml",
          "echo bad > escape/outside",
          "cat .env",
          "cat alias",
          "cat private.pem",
          "cat id_ed25519",
        ]) {
          const result = await f.runtime.execute(["/bin/sh", "-c", command], f.signal)
          expect(result.exitCode, JSON.stringify(result)).not.toBe(0)
          expect(result.stdout).not.toContain("SECRET_CANARY")
          expect(result.stdout).not.toContain("PEM_CANARY")
          expect(result.stdout).not.toContain("SSH_CANARY")
        }
        expect(await Bun.file(join(f.parent, "outside")).exists()).toBe(false)
      } finally {
        await f.close()
      }
    }, 60_000)
    test("plan mode confines shell writes and permits exactly the plan file", async () => {
      const f = await fixture()
      try {
        const denied = await f.runtime.execute(["/bin/sh", "-c", "echo bad > nope"], f.signal, "plan")
        expect(denied.exitCode).not.toBe(0)
        const result = await f.runtime.runTool(
          writeFileTool,
          { path: ".codesplash/plan.md", content: "Plan" },
          await f.context("plan"),
        )
        expect(result, JSON.stringify(result)).not.toHaveProperty("isError", true)
        expect(await readFile(join(f.cwd, ".codesplash/plan.md"), "utf8")).toBe("Plan")
        await expect(
          f.runtime.runTool(writeFileTool, { path: "nope", content: "bad" }, await f.context("plan")),
        ).rejects.toThrow("Sandbox path denied")
      } finally {
        await f.close()
      }
    }, 60_000)
    test("scoped write grants expire and read-only profiles cannot grant writes", async () => {
      const f = await fixture()
      try {
        const external = join(f.parent, "external")
        await mkdir(external)
        const grant = f.runtime.validateGrant(
          { resource: "write", target: external, scope: "turn" },
          "default",
        )
        f.runtime.grant(grant)
        const allowed = await f.runtime.execute(["/bin/sh", "-c", "echo yes > ../external/ok"], f.signal)
        expect(allowed.exitCode, JSON.stringify(allowed)).toBe(0)
        f.runtime.endTurn()
        const denied = await f.runtime.execute(["/bin/sh", "-c", "echo no > ../external/after"], f.signal)
        expect(denied.exitCode).not.toBe(0)
        const readonly = new NativeSandbox(createProfile(f.cwd, "read-only"))
        expect(() => readonly.validateGrant(grant, "default")).toThrow("read-only")
        await readonly.close()
      } finally {
        await f.close()
      }
    }, 60_000)
    test("file tools refuse pre-existing hardlinks", async () => {
      const f = await fixture()
      try {
        const outside = join(f.parent, "secret")
        await writeFile(outside, "canary")
        await link(outside, join(f.cwd, "alias"))
        await expect(f.runtime.runTool(readFileTool, { path: "alias" }, await f.context())).rejects.toThrow(
          "multiply-linked",
        )
      } finally {
        await f.close()
      }
    })
    test("shell and CLI execution refuse pre-existing aliases before any side effects", async () => {
      const f = await fixture()
      try {
        const outside = join(f.parent, "outside")
        await writeFile(outside, "unchanged")
        await link(outside, join(f.cwd, "alias"))
        const result = await f.runtime.execute(
          ["/bin/bash", "-c", "touch side-effect; printf changed > alias"],
          f.signal,
        )
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("multiply-linked")
        expect(await readFile(outside, "utf8")).toBe("unchanged")
        expect(await Bun.file(join(f.cwd, "side-effect")).exists()).toBe(false)
        const tool = await f.runtime.runTool(
          bashTool,
          { command: "printf changed > alias" },
          await f.context(),
        )
        expect(tool.isError).toBe(true)
        expect(await readFile(outside, "utf8")).toBe("unchanged")
      } finally {
        await f.close()
      }
    }, 30_000)
    test("cannot create a writable hardlink from a granted read-only file", async () => {
      const f = await fixture()
      try {
        const outside = join(f.parent, "outside")
        await writeFile(outside, "unchanged")
        f.runtime.grant(
          f.runtime.validateGrant({ resource: "read", target: outside, scope: "turn" }, "default"),
        )
        const read = await f.runtime.execute(["/bin/cat", outside], f.signal)
        expect(read.exitCode, JSON.stringify(read)).toBe(0)
        const result = await f.runtime.execute(
          ["/bin/bash", "-c", "ln ../outside alias && printf changed > alias"],
          f.signal,
        )
        expect(result.exitCode).not.toBe(0)
        expect(await readFile(outside, "utf8")).toBe("unchanged")
        expect(await Bun.file(join(f.cwd, "alias")).exists()).toBe(false)
      } finally {
        await f.close()
      }
    }, 30_000)
    test("read grants expire at turn end and session grants are cleared on close", async () => {
      const f = await fixture()
      try {
        const outside = join(f.parent, "outside")
        await writeFile(outside, "read canary")
        f.runtime.grant(
          f.runtime.validateGrant({ resource: "read", target: outside, scope: "turn" }, "default"),
        )
        expect((await f.runtime.execute(["/bin/cat", outside], f.signal)).stdout.trim()).toBe("read canary")
        f.runtime.endTurn()
        expect((await f.runtime.execute(["/bin/cat", outside], f.signal)).exitCode).not.toBe(0)
        f.runtime.grant(
          f.runtime.validateGrant({ resource: "read", target: outside, scope: "session" }, "default"),
        )
        f.runtime.endTurn()
        expect((await f.runtime.execute(["/bin/cat", outside], f.signal)).stdout.trim()).toBe("read canary")
        await f.runtime.close()
        await expect(f.runtime.execute(["/bin/echo", "no"], f.signal)).rejects.toThrow("closed")
        const reopened = new NativeSandbox(f.runtime.profile)
        try {
          expect((await reopened.execute(["/bin/cat", outside], f.signal)).exitCode).not.toBe(0)
        } finally {
          await reopened.close()
        }
      } finally {
        await f.close()
      }
    }, 30_000)
    test("direct network and inherited credentials are inaccessible", async () => {
      const f = await fixture()
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response("SHOULD_NOT_REACH"),
      })
      const old = process.env.TEST_SANDBOX_SECRET
      process.env.TEST_SANDBOX_SECRET = "canary-exported-credential"
      try {
        const direct = await f.runtime.execute(
          ["/usr/bin/curl", "--noproxy", "*", "--connect-timeout", "1", `http://127.0.0.1:${server.port}`],
          f.signal,
        )
        expect(direct.exitCode).not.toBe(0)
        expect(direct.stdout).not.toContain("SHOULD_NOT_REACH")
        const env = await f.runtime.execute(["/usr/bin/env"], f.signal)
        expect(env.exitCode, JSON.stringify(env)).toBe(0)
        expect(env.stdout).not.toContain("canary-exported-credential")
      } finally {
        if (old === undefined) delete process.env.TEST_SANDBOX_SECRET
        else process.env.TEST_SANDBOX_SECRET = old
        server.stop(true)
        await f.close()
      }
    }, 60_000)
    test("named-secret stdout/stderr is redacted before truncation and transport", async () => {
      const f = await fixture()
      const secret = 'a"complex\nsecret-value-123'
      const store = new NamedSecrets(f.parent, {
        async get() {
          return secret
        },
        async set() {},
        async delete() {
          return true
        },
      })
      const runtime = new NativeSandbox(createProfile(f.cwd, "workspace-write"), undefined, store)
      try {
        const result = await runtime.runTool(
          bashTool,
          {
            command: 'printf "%s" "$DEPLOY_TOKEN"; printf "%s" "$DEPLOY_TOKEN" >&2',
            secrets: ["DEPLOY_TOKEN"],
          },
          await f.context(),
        )
        expect(result, JSON.stringify(result)).not.toHaveProperty("isError", true)
        expect(result.text).not.toContain(secret)
        expect(result.text).toContain("[REDACTED]")
      } finally {
        await runtime.close()
        await f.close()
      }
    }, 60_000)
    test("redacts file contents before line selection and output caps", async () => {
      const f = await fixture()
      const secret = `FILE_SECRET_START_${"q".repeat(80)}_FILE_SECRET_END`
      const store = new NamedSecrets(f.parent, {
        async get() {
          return secret
        },
        async set() {},
        async delete() {
          return true
        },
      })
      const runtime = new NativeSandbox(createProfile(f.cwd, "workspace-write"), undefined, store)
      try {
        const bound = await runtime.runTool(
          bashTool,
          { command: "true", secrets: ["FILE_TOKEN"] },
          await f.context(),
        )
        expect(bound.isError).not.toBe(true)
        await writeFile(join(f.cwd, "long.txt"), "x".repeat(50 * 1024 - 20) + secret)
        const read = await runtime.runTool(readFileTool, { path: "long.txt" }, await f.context())
        expect(read.isError).not.toBe(true)
        expect(read.text).toContain("[REDACTED]")
        expect(read.text).not.toContain("FILE_SECRET_START")
        const search = await runtime.runTool(grepTool, { pattern: "x", glob: "long.txt" }, await f.context())
        expect(search.isError).not.toBe(true)
        expect(search.text).not.toContain("FILE_SECRET_START")
      } finally {
        await runtime.close()
        await f.close()
      }
    }, 30_000)
    test("writable children under read-only roots retain protected-path denials", async () => {
      const f = await fixture()
      await mkdir(join(f.cwd, ".git"))
      await writeFile(join(f.cwd, ".env"), "MASKED_CANARY")
      await writeFile(join(f.parent, "outside.txt"), "outside")
      const runtime = new NativeSandbox(createProfile(f.cwd, "workspace-write", { readRoots: [f.parent] }))
      try {
        const result = await runtime.execute(["/bin/sh", "-c", "printf ok > allowed"], f.signal)
        expect(result, JSON.stringify(result)).toMatchObject({ kind: "success" })
        expect(await readFile(join(f.cwd, "allowed"), "utf8")).toBe("ok")
        for (const command of ["echo bad > .git/config", "echo bad > ../outside.txt"])
          expect((await runtime.execute(["/bin/sh", "-c", command], f.signal)).exitCode).not.toBe(0)
        expect((await runtime.execute(["/bin/cat", ".env"], f.signal)).stdout).not.toContain("MASKED_CANARY")
        expect(await readFile(join(f.parent, "outside.txt"), "utf8")).toBe("outside")
      } finally {
        await runtime.close()
        await f.close()
      }
    }, 30_000)
    for (const cancel of [false, true])
      test(`terminates detached descendants on ${cancel ? "cancellation" : "normal exit"}`, async () => {
        const f = await fixture()
        const abort = new AbortController()
        const heartbeat = join(f.cwd, "heartbeat")
        const daemon =
          'await Bun.write("heartbeat", String(Date.now())); setInterval(() => { void Bun.write("heartbeat", String(Date.now())) }, 30)'
        const parent = `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(daemon)}], {detached:true,stdin:"ignore",stdout:"ignore",stderr:"ignore"}); child.unref(); while (!await Bun.file("heartbeat").exists()) await Bun.sleep(10); await Bun.sleep(${cancel ? 30_000 : 50});`
        try {
          const running = f.runtime.execute([process.execPath, "-e", parent], abort.signal)
          if (cancel) {
            for (let i = 0; i < 500 && !(await Bun.file(heartbeat).exists()); i++) await Bun.sleep(10)
            abort.abort()
          }
          const result = await running
          expect(result, JSON.stringify(result)).toMatchObject({ kind: cancel ? "interrupted" : "success" })
          const before = await readFile(heartbeat, "utf8")
          await Bun.sleep(200)
          expect(await readFile(heartbeat, "utf8")).toBe(before)
          // The reaper must not affect unrelated host processes (this test process survives).
          expect(process.pid).toBeGreaterThan(1)
        } finally {
          abort.abort()
          await f.close()
        }
      }, 15_000)
    test.skipIf(process.platform !== "darwin")(
      "macOS descendants cannot replace their cleanup policy",
      async () => {
        const f = await fixture()
        try {
          const result = await f.runtime.execute(
            ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "/bin/echo", "replaced"],
            f.signal,
          )
          expect(result.exitCode).not.toBe(0)
          expect(result.stdout).not.toContain("replaced")
        } finally {
          await f.close()
        }
      },
    )
    test("cancels a running process tree promptly", async () => {
      const f = await fixture(),
        abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), 600)
      try {
        const result = await f.runtime.execute(["/bin/sh", "-c", "sleep 30 & wait"], abort.signal)
        expect(result.kind).toBe("interrupted")
        expect(result.exitCode).toBe(130)
      } finally {
        clearTimeout(timer)
        await f.close()
      }
    }, 10_000)
  },
)

describe("network and CLI boundaries", () => {
  test("cached pages recheck grants and trusted transport retains the approved hostname", async () => {
    const tool = createWebFetchTool({
      resolveAddresses: async () => ["93.184.216.34"],
      fetchImpl: (async () => {
        throw new Error("unconfined transport must not run")
      }) as unknown as typeof fetch,
    })
    let allowed = true,
      calls = 0
    const context = {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      policy: { sandbox: "read-only" as const, approvalPolicy: "on-request" as const },
      checkNetwork() {
        if (!allowed) throw new Error("Grant expired")
      },
      async fetchNetwork(url: string) {
        expect(url).toBe("http://example.com/")
        calls++
        return new Response("cached canary", { headers: { "content-type": "text/plain" } })
      },
    }
    expect((await tool.run({ url: "http://example.com/" }, context)).text).toContain("cached canary")
    allowed = false
    const denied = await tool.run({ url: "http://example.com/" }, context)
    expect(denied.isError).toBe(true)
    expect(denied.text).not.toContain("cached canary")
    expect(calls).toBe(1)
  })
  test("search refuses redirects without sending to the unapproved destination", async () => {
    let reached = 0
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        reached++
        return new Response("fixture")
      },
    })
    const origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.redirect(`http://127.0.0.1:${target.port}/`, 302)
      },
    })
    const endpoint = `http://127.0.0.1:${origin.port}/`
    try {
      const result = await createWebSearchTool({ endpoint }).run(
        { query: "fixture" },
        {
          cwd: process.cwd(),
          signal: AbortSignal.timeout(5000),
          policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
          checkNetwork(url) {
            if (url !== endpoint) throw new Error("No grant")
          },
        },
      )
      expect(result.isError).toBe(true)
      expect(reached).toBe(0)
    } finally {
      origin.stop(true)
      target.stop(true)
    }
  })
  test("preserves literal argv following --", () => {
    expect(parseSandboxArguments(["--no-history", "--", "echo", "--version", "$(no)", "a b"]).argv).toEqual([
      "echo",
      "--version",
      "$(no)",
      "a b",
    ])
    expect(() => parseSandboxArguments(["--read-only", "--write-root", "/tmp/build", "--", "echo"])).toThrow(
      "conflicts",
    )
  })
  test("broker pins vetted answers and rejects other hosts/private addresses", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("approved fixture"),
    })
    let lookups = 0
    const broker = await startNetworkBroker([`fixture.example:${server.port}`], {
      resolve: async () => {
        lookups++
        return ["127.0.0.1"]
      },
      blocked: () => undefined,
    })
    const privateBroker = await startNetworkBroker([`fixture.example:${server.port}`], {
      resolve: async () => ["127.0.0.1"],
    })
    try {
      const allowed = await fetch(`http://fixture.example:${server.port}`, { proxy: broker.url })
      expect(await allowed.text()).toBe("approved fixture")
      expect(lookups).toBe(1)
      const denied = await fetch(`http://other.example:${server.port}`, { proxy: broker.url })
      expect(denied.status).toBe(403)
      const privateResult = await fetch(`http://fixture.example:${server.port}`, { proxy: privateBroker.url })
      expect(privateResult.status).toBe(403)
    } finally {
      broker.close()
      privateBroker.close()
      server.stop(true)
    }
  })
})
