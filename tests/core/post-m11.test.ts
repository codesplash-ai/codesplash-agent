import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseAppArguments } from "../../src/cli.ts"
import {
  browserIdentity,
  browserLogin,
  browserLogout,
  browserToken,
} from "../../src/core/identity/browser.ts"
import type { SecretStore } from "../../src/core/identity/keyring.ts"
import { launchInput, readLaunchPipe } from "../../src/core/launch-input.ts"
import { git } from "../../src/core/orchestration/git.ts"
import { GitProjection, projectionPaths } from "../../src/core/orchestration/projection.ts"
import { digest } from "../../src/core/session/files.ts"
import { indexSymbols, WorkspaceIndex } from "../../src/engines/codesplash/language/workspace-index.ts"
import { refreshModels } from "../../src/engines/codesplash/model-cache.ts"
import { anthropicModels } from "../../src/engines/codesplash/providers/anthropic.ts"

const roots: string[] = [],
  originalFetch = globalThis.fetch,
  originalEnv = { ...process.env }
afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function root() {
  const r = realpathSync(mkdtempSync(join(tmpdir(), "post-m11-")))
  roots.push(r)
  return r
}
test("launcher accepts literal files, explicit seed and unambiguous resume modes", async () => {
  const value = parseAppArguments(["--path", "/repo", "-p", "seed", "--file", "a file.png", "--continue"])
  expect(value.path).toBe("/repo")
  expect(value.options.launch).toEqual({ files: ["a file.png"], prompt: "seed", continue: true })
  expect(launchInput("/repo", "seed", ["a file.png", "a file.ts"])).toEqual({
    text: "seed",
    images: ["/repo/a file.png"],
    files: ["/repo/a file.ts"],
  })
  expect(() => parseAppArguments(["--resume", "x", "--continue"])).toThrow()
  expect(() => parseAppArguments(["--resume", "x", "--no-history"])).toThrow()
  expect(
    await readLaunchPipe(
      (async function* () {
        yield Buffer.from("hello ")
        yield Buffer.from("world")
      })(),
    ),
  ).toBe("hello world")
  await expect(
    readLaunchPipe(
      (async function* () {
        yield Buffer.alloc(1024 * 1024 + 1)
      })(),
    ),
  ).rejects.toThrow("1 MiB")
})
test("browser PKCE binds callback state, refreshes rotated credentials and logs out without plaintext", async () => {
  const r = root()
  process.env.CODESPLASH_AGENT_CONFIG_DIR = r
  const secrets = new Map<string, string>(),
    store: SecretStore = {
      async get(o) {
        return secrets.get(o.name) ?? null
      },
      async set(o) {
        secrets.set(o.name, o.value)
      },
      async delete(o) {
        return secrets.delete(o.name)
      },
    }
  const identity = {
    clientId: "registered-client",
    authorizationUrl: "https://issuer.example/authorize",
    tokenUrl: "https://issuer.example/token",
    scope: "model offline_access",
    resourceOrigin: "https://models.example",
    revocationUrl: "https://issuer.example/revoke",
  }
  let challenge = "",
    exchanges = 0,
    revocations = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname === "127.0.0.1") return originalFetch(input, init)
    const body = new URLSearchParams(String(init?.body))
    if (url.pathname === "/revoke") {
      revocations++
      expect(body.get("token")).toBe("refresh-two")
      return new Response(null, { status: 200 })
    }
    exchanges++
    if (exchanges === 1) {
      expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(challenge)
      expect(body.get("code")).toBe("authorization-code")
    } else {
      expect(body.get("refresh_token")).toBe("refresh-one")
    }
    return Response.json({
      access_token: `access-${exchanges}`,
      refresh_token: exchanges === 1 ? "refresh-one" : "refresh-two",
      expires_in: exchanges === 1 ? 10 : 3600,
      token_type: "Bearer",
    })
  }) as typeof fetch
  await browserLogin(
    identity,
    async (text) => {
      const auth = new URL(text),
        callback = new URL(auth.searchParams.get("redirect_uri")!)
      challenge = auth.searchParams.get("code_challenge")!
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256")
      callback.searchParams.set("state", "wrong")
      callback.searchParams.set("code", "authorization-code")
      expect((await originalFetch(callback)).status).toBe(400)
      callback.searchParams.set("state", auth.searchParams.get("state")!)
      expect((await originalFetch(callback)).status).toBe(200)
      expect((await originalFetch(callback)).status).toBe(400)
    },
    { root: r, store, signal: AbortSignal.timeout(5000) },
  )
  expect(await browserToken(identity, { root: r, store })).toBe("access-2")
  expect(exchanges).toBe(2)
  await browserLogout(identity, { root: r, store })
  expect(revocations).toBe(1)
  expect(secrets.size).toBe(0)
  await expect(browserToken(identity, { root: r, store })).rejects.toThrow("not logged in")
  expect(() => browserIdentity({ ...identity, tokenUrl: "https://other.example/token" })).toThrow(
    "same-issuer",
  )
})
test("workspace symbol graph persists structured locations with bounded content and no-history stays in memory", () => {
  const r = root(),
    symbols = indexSymbols([
      {
        name: "outer",
        kind: 12,
        range: { start: { line: 1, character: 0 } },
        children: [{ name: "inner", position: { line: 2, character: 4 } }],
      },
    ])
  const index = new WorkspaceIndex(r, "/workspace", true),
    entry = { hash: digest("source"), descriptors: digest("review"), symbols }
  index.update({ "/workspace/source.ts": entry })
  expect(new WorkspaceIndex(r, "/workspace", true).read().files["/workspace/source.ts"]).toEqual(entry)
  const memory = new WorkspaceIndex(r, "/ephemeral", false)
  memory.update({ "/ephemeral/a": entry })
  expect(existsSync(memory.directory)).toBe(false)
  expect(() => indexSymbols({ captures: "unstructured" })).toThrow("structured JSON")
})
test("catalog ETags never bypass a reviewed checksum and 304 requires verified cached bytes", async () => {
  const path = join(root(), "catalog.json"),
    source = JSON.stringify({ version: 1, models: anthropicModels }),
    sha = digest(source)
  let calls = 0
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++
    if (calls === 1) return new Response(source, { headers: { etag: '"fixture"' } })
    expect(new Headers(init?.headers).get("if-none-match")).toBe('"fixture"')
    return new Response(null, { status: 304 })
  }) as typeof fetch
  await refreshModels("https://catalog.example/models", sha, path)
  expect(await refreshModels("https://catalog.example/models", sha, path)).toMatchObject({
    notModified: true,
  })
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      source: "altered",
      sha256: sha,
      url: "https://catalog.example/models",
      etag: '"fixture"',
    }),
  )
  globalThis.fetch = (async () => new Response(null, { status: 304 })) as unknown as typeof fetch
  await expect(refreshModels("https://catalog.example/models", sha, path)).rejects.toThrow(
    "without a verified",
  )
})
test("Git projection clones independent content objects, expands clean trees and preserves dirty work", async () => {
  const r = root(),
    source = join(r, "source"),
    target = join(r, "projected")
  mkdirSync(source)
  mkdirSync(join(source, "a"))
  mkdirSync(join(source, "b"))
  writeFileSync(join(source, "a", "one"), "one")
  writeFileSync(join(source, "b", "two"), "two")
  await git(source, ["init", "-q"])
  await git(source, ["add", "."])
  await git(source, ["commit", "-qm", "base"])
  const projection = new GitProjection(target, join(r, "state"))
  expect((await projection.create(source, ["a"])).state).toBe("ready")
  expect(existsSync(join(target, "a", "one"))).toBe(true)
  expect(existsSync(join(target, "b", "two"))).toBe(false)
  expect(existsSync(join(target, ".git", "objects", "info", "alternates"))).toBe(false)
  await projection.expand(["b"])
  expect(existsSync(join(target, "b", "two"))).toBe(true)
  writeFileSync(join(target, "a", "one"), "user work")
  await expect(projection.expand(["c"])).rejects.toThrow("user work")
  expect(() => projectionPaths(["../escape"])).toThrow("literal")
}, 30000)
