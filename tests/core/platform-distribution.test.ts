import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { publicStats } from "../../scripts/build-docs.ts"
import { diskUsage } from "../../src/commands/disk.ts"
import { startKeyProxy } from "../../src/commands/key-proxy.ts"
import { ClipboardWrap } from "../../src/commands/wrap.ts"
import { dispatchArguments, validateBrand } from "../../src/core/distribution/brand.ts"
import { detectInstallMethod } from "../../src/core/distribution/update.ts"
import { pathContains, shellCommand, validateWindowsPath } from "../../src/core/platform.ts"
import { denyPrefix } from "../../src/engines/codesplash/sandbox/profile.ts"

test("Windows paths reject device aliases and alternate streams; PowerShell preserves literal command bytes", () => {
  expect(pathContains("C:\\Project", "c:\\project\\src\\a.ts", "win32")).toBe(true)
  expect(pathContains("C:\\Project", "C:\\Project-other\\a.ts", "win32")).toBe(false)
  expect(pathContains("C:\\Project", "D:\\Project\\a.ts", "win32")).toBe(false)
  for (const path of [
    "C:\\x\\file:stream",
    "C:\\x\\NUL.txt",
    "\\\\server\\share",
    "C:\\x\\..\\outside",
    "C:\\x\\name.",
  ])
    expect(() => validateWindowsPath(path)).toThrow()
  expect(() => validateWindowsPath("C:\\Project Files\\file.ts")).not.toThrow()
  const command = 'Write-Output "quotes `$ and unicode α"',
    args = shellCommand(command, "win32", {})
  expect(args.slice(1, 5)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
  expect(Buffer.from(args[5]!, "base64").toString("utf16le")).toBe(command)
  expect(shellCommand("echo ok", "win32", { CODESPLASH_WINDOWS_SHELL: "cmd" }).slice(1)).toEqual([
    "/d",
    "/s",
    "/c",
    "echo ok",
  ])
})
test("fixed dispatch and public brand validation cannot load arbitrary helpers", () => {
  expect(dispatchArguments("/usr/bin/codesplash-sandbox", ["--", "echo", "ok"])).toEqual([
    "sandbox",
    "--",
    "echo",
    "ok",
  ])
  expect(dispatchArguments("C:\\tools\\codesplash-key-proxy.exe", [])).toEqual(["key-proxy"])
  expect(dispatchArguments("unknown-helper", ["--version"])).toEqual(["--version"])
  expect(() =>
    validateBrand({
      name: "bad\nname",
      command: "good",
      variant: "public",
      supportUrl: "https://example.com",
    }),
  ).toThrow()
  expect(() =>
    validateBrand({ name: "Good", command: "good", variant: "internal", supportUrl: "http://example.com" }),
  ).toThrow()
})
test("disk accounting skips symlinks and reports traversal bounds; denies include future glob matches", async () => {
  const root = mkdtempSync(join(tmpdir(), "m11-disk-"))
  try {
    mkdirSync(join(root, "child"))
    writeFileSync(join(root, "child", "data"), "abc")
    symlinkSync(root, join(root, "cycle"))
    expect(await diskUsage(root)).toEqual({ bytes: 3, files: 1, skippedLinks: 1, truncated: false })
    expect((await diskUsage(root, 1)).truncated).toBe(true)
    expect(denyPrefix(`${root}/child/**/*.secret`)).toBe(
      root.startsWith("/var/") ? `/private${root}/child` : `${root}/child`,
    )
    expect(() => denyPrefix("/**/*.secret")).toThrow("scoped")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test("clipboard wrapping handles fragmented OSC, blocks queries and wraps approved writes for tmux", () => {
  const blocked = new ClipboardWrap(false, false),
    allowed = new ClipboardWrap(true, true)
  expect(blocked.push(Buffer.from("before\x1b]5"))).toBe("before")
  expect(blocked.push(Buffer.from("2;c;c2VjcmV0\x07after"))).toBe("after")
  expect(allowed.push(Buffer.from("\x1b]52;c;?\x07"))).toBe("")
  expect(allowed.push(Buffer.from("\x1b]52;c;aGk=\x1b\\"))).toBe("\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\")
})
test("public stats discard all names, paths and unknown fields", () => {
  expect(
    publicStats([
      {
        engine: "secret-name",
        model: "secret",
        sessions: 2,
        inputTokens: 5,
        outputTokens: 8,
        estimatedCostUsd: 0.1,
        path: "/private",
      },
    ]),
  ).toEqual({ sessions: 2, inputTokens: 5, outputTokens: 8, estimatedCostUsd: 0.1 })
  expect(() => publicStats([{ sessions: -1 }])).toThrow()
})
test("key injection proxy rejects unauthorized routes and strips upstream key echoes", async () => {
  const original = globalThis.fetch
  let requests = 0
  globalThis.fetch = ((input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === "127.0.0.1") return original(input, init)
    requests++
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer upstream-secret")
    expect(url.href).toBe("https://api.example.com/v1/responses")
    return Promise.resolve(new Response('data: {"text":"upstream-secret"}\n\n'))
  }) as typeof fetch
  const proxy = await startKeyProxy(
    { version: 1, provider: "openai", origin: "https://api.example.com", secret: "TEST" },
    async () => "upstream-secret",
  )
  try {
    expect((await original(`${proxy.url}/v1/responses`, { method: "POST" })).status).toBe(401)
    const init = { method: "POST", headers: { authorization: `Bearer ${proxy.token}` }, body: "{}" }
    expect((await original(`${proxy.url}/anything`, init)).status).toBe(403)
    const response = await original(`${proxy.url}/v1/responses`, init)
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain("upstream-secret")
    expect(requests).toBe(1)
  } finally {
    proxy.close()
    globalThis.fetch = original
  }
})

test("install detection distinguishes the application from its Homebrew Bun runtime", () => {
  expect(detectInstallMethod("/repo/src/cli.ts", "/opt/homebrew/Cellar/bun/1.3.14/bin/bun")).toBe("source")
  expect(
    detectInstallMethod(
      "/usr/local/lib/node_modules/codesplash-agent/dist/cli.js",
      "/opt/homebrew/Cellar/bun/1.3.14/bin/bun",
    ),
  ).toBe("npm")
  expect(
    detectInstallMethod(
      "/$bunfs/root/cli.js",
      "/opt/homebrew/Cellar/codesplash-agent/0.1.4/libexec/codesplash",
    ),
  ).toBe("homebrew")
})

test("clipboard filter drops C1, passthrough and oversized strings across arbitrary byte splits", () => {
  const attacks = [
    "\x1b\u009d52;c;aGk=\u009c",
    "\x1b]052;c;aGk=\x07",
    "\x1b]1337;CopyToClipboard=aGk=\x07",
    "\u009d52;c;aGk=\u009c",
    "\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\",
    "\u0090\u009d52;c;aGk=\x07\u009c",
    "\x1b]0;title\x1b]52;c;aGk=\x07",
    `\x1b]0;${"x".repeat(128 * 1024)}\x1b]52;c;aGk=\x07`,
  ]
  for (const attack of attacks) {
    const filter = new ClipboardWrap(false, false)
    let output = ""
    for (const byte of Buffer.from(`before${attack}after`)) output += filter.push(Uint8Array.of(byte))
    output += filter.push(new Uint8Array(), true)
    expect(output).toBe("beforeafter")
  }
  const allowed = new ClipboardWrap(true, false)
  expect(allowed.push(Buffer.from("\u009d52;c;aGk=\u009c"))).toBe("\x1b]52;c;aGk=\x07")
  expect(allowed.push(Buffer.from("\x1b[31mred\x1b[0m"))).toBe("\x1b[31mred\x1b[0m")
})
