import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unknownConfigFields } from "../../src/core/config/resolver.ts"
import { loadConfig, saveConfig, validateConfig } from "../../src/core/config.ts"
import { HOOK_EVENTS, hookMatches } from "../../src/core/hooks.ts"
import { validateHookResult } from "../../src/engines/codesplash/hooks/results.ts"

const rawHandler = { kind: "command", command: "/bin/cat", events: ["tool.before"] }
const config = (handler: unknown) => validateConfig({ hooks: { handlers: { fixture: handler } } }, "fixture")
function handler(value: unknown = rawHandler) {
  const result = config(value).hooks?.handlers.fixture
  if (!result) throw new Error("Fixture hook missing")
  return result
}

test("hook configuration is inert, literal and bounded with reviewed result capabilities", () => {
  expect(handler()).toMatchObject({
    enabled: false,
    share: [],
    async: false,
    timeoutMs: 10000,
    writeWorkspace: false,
  })
  expect(handler({ ...rawHandler, args: ["", "arg", "arg"] }).args).toEqual(["", "arg", "arg"])
  for (const changed of [
    { token: "DO_NOT_COPY" },
    { environment: ["NODE_OPTIONS"] },
    { async: true },
    { events: ["subagent.start"] },
    { matchTools: ["(a+)+$"] },
    { matchTools: ["a**"] },
    { allowDefaultApproval: true },
    { allowContinuation: true },
    { timeoutMs: 30001 },
  ])
    expect(() => handler({ ...rawHandler, ...changed })).toThrow()
  expect(() => handler({ kind: "http", url: "http://localhost/hook", events: ["tool.after"] })).toThrow(
    "loopback",
  )
  expect(
    handler({ kind: "http", url: "http://127.0.0.1:9999/hook", allowLoopback: true, events: ["tool.after"] })
      .kind,
  ).toBe("http")
  expect(hookMatches("mcp:fixture/*", "mcp:fixture/search")).toBe(true)
  expect(hookMatches("bash", "other_bash")).toBe(false)
  expect(hookMatches("pre*suf", "presuf")).toBe(true)
  expect(hookMatches("pre*suf", "prefix")).toBe(false)
})

test("hook outputs cannot smuggle changes through observations or unreviewed capabilities", () => {
  expect(
    validateHookResult("tool.before", { version: 1, decision: "deny", reason: "fixture" }, handler()),
  ).toMatchObject({ decision: "deny" })
  expect(() => validateHookResult("tool.before", { version: 1, input: {} }, handler())).toThrow("rewrite")
  expect(() => validateHookResult("tool.before", { version: 1, decision: "allow" }, handler())).toThrow(
    "review",
  )
  expect(() => validateHookResult("turn.end", { version: 1, decision: "deny" }, handler())).toThrow("event")
  expect(() => validateHookResult("compaction.before", { version: 1, messages: [] }, handler())).toThrow(
    "Unknown",
  )
  const rewrite = handler({ ...rawHandler, allowInputRewrite: true })
  expect(validateHookResult("tool.before", { version: 1, input: { path: "next" } }, rewrite)).toMatchObject({
    input: { path: "next" },
  })
  expect(() =>
    validateHookResult("tool.before", { version: 1, decision: "deny", input: {} }, rewrite),
  ).toThrow("denied")
  const observer = handler({ ...rawHandler, events: ["tool.after"], async: true })
  expect(() => validateHookResult("tool.after", { version: 1, context: "late" }, observer)).toThrow("Async")
  const stop = handler({ ...rawHandler, events: ["turn.stop"], allowContinuation: true })
  expect(
    validateHookResult("turn.stop", { version: 1, continuation: "Check the result" }, stop),
  ).toMatchObject({ continuation: "Check the result" })
  expect(() => validateHookResult("turn.stop", { version: 1, continuation: " " }, stop)).toThrow(
    "continuation",
  )
  expect(() =>
    validateHookResult("tool.before", { version: 1, context: "x".repeat(128 * 1024) }, handler()),
  ).toThrow("byte")
})

test("hook resolver profiles narrow budgets, enforce managed declarations and roundtrip", async () => {
  const root = await mkdtemp(join(tmpdir(), "hooks-config-")),
    path = join(root, "config.toml")
  try {
    await writeFile(
      path,
      '[hooks.handlers.fixture]\nkind="command"\ncommand="/bin/cat"\nevents=["tool.before"]\n[hooks.continuation]\nmaxCount=2\nmaxTokens=1000\n[profiles.wider.hooks.continuation]\nmaxCount=8\nmaxTokens=2000\n',
    )
    await writeFile(
      join(root, "managed.toml"),
      'hookHandlers=["fixture"]\nhookEvents=["tool.before"]\nhooksManagedOnly=true\n',
    )
    const loaded = await loadConfig(path, [], {
      cwd: root,
      env: {},
      workspaceTrusted: false,
      profile: "wider",
      strict: true,
    })
    expect(loaded.hooks?.continuation).toMatchObject({ maxCount: 2, maxTokens: 1000 })
    expect(loaded.resolution?.constraints).toMatchObject({
      hookHandlers: ["fixture"],
      hookEvents: ["tool.before"],
      hooksManagedOnly: true,
    })
    expect(unknownConfigFields(Bun.TOML.parse(await readFile(path, "utf8")))).toEqual([])
    const plain = config(rawHandler)
    await saveConfig(plain, path)
    expect((await loadConfig(path)).hooks).toEqual(plain.hooks)
    expect(HOOK_EVENTS.length).toBe(22)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
