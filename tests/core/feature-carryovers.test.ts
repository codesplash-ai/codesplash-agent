import { expect, test } from "bun:test"
import { type DiagnosticRecord, Diagnostics, diagnosticContext } from "../../src/core/diagnostics.ts"
import { modelFamily } from "../../src/core/model-family.ts"
import {
  classifyCommand,
  classifyInvocation,
  recordToolOperation,
} from "../../src/core/operation-telemetry.ts"
import { attachStartupTiming, measureStartup } from "../../src/core/startup-timing.ts"
import type { ProviderRequest, ToolContext } from "../../src/engines/codesplash/contracts.ts"
import { anthropicModels, buildRequestBody } from "../../src/engines/codesplash/providers/anthropic.ts"
import { WireCacheTracker } from "../../src/engines/codesplash/providers/cache-diagnostics.ts"
import { searchDomains } from "../../src/engines/codesplash/tools/search-domains.ts"
import { createWebSearchTool } from "../../src/engines/codesplash/tools/web-search.ts"

test("search filters decode result wrappers and intersect caller filters with operator ceilings", async () => {
  const html = [
    "https://allowed.test/a",
    "https://sub.allowed.test/b",
    "https://blocked.allowed.test/c",
    "https://allowed.test.evil.test/d",
  ]
    .map(
      (url) =>
        `<a class="result__a" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent(url)}">result</a>`,
    )
    .join("\n")
  const tool = createWebSearchTool({
    allowedDomains: ["ALLOWED.test."],
    blockedDomains: ["blocked.allowed.test"],
    fetchImpl: (async () => new Response(html)) as unknown as typeof fetch,
  })
  const ctx = { signal: new AbortController().signal } as ToolContext
  const result = await tool.run(
    {
      query: "query",
      count: 1,
      blocked_domains: ["allowed.test.evil.test"],
      allowed_domains: ["sub.allowed.test", "evil.test"],
    },
    ctx,
  )
  expect(result.text).toContain("https://sub.allowed.test/b")
  expect(result.text).not.toContain("/a")
  expect(result.text).not.toContain("evil.test")
  expect((await tool.run({ query: "query", allowed_domains: [] }, ctx)).text).toContain("No search results")
  for (const value of [
    "https://allowed.test",
    "*.allowed.test",
    "allowed.test:443",
    "allowed.test@evil.test",
    "allowed.test/path",
  ])
    expect(() => searchDomains([value])).toThrow()
  expect(searchDomains(["bücher.test"])).toEqual(["xn--bcher-kva.test"])
})

test("prompt cache is explicit, does not mutate input and diagnostics preserve only categories", async () => {
  const request: ProviderRequest = {
    model: { ...anthropicModels[0]! },
    system: "private-system",
    messages: [{ role: "user", content: [{ type: "text", text: "private-message" }] }],
    tools: [],
  }
  expect(buildRequestBody(request).system).toBe("private-system")
  request.model.promptCache = "conversation"
  const body = buildRequestBody(request)
  expect(body.cache_control).toEqual({ type: "ephemeral" })
  expect(body.system).toEqual([
    { type: "text", text: "private-system", cache_control: { type: "ephemeral" } },
  ])
  expect(request.system).toBe("private-system")
  const records: DiagnosticRecord[] = [],
    log = new Diagnostics(undefined, (r) => records.push(r)),
    tracker = new WireCacheTracker()
  await diagnosticContext.run(log, async () => {
    tracker.inspect(body)
    tracker.inspect({
      ...body,
      messages: [...(body.messages as unknown[]), { role: "assistant", content: "answer" }],
    })
    expect(records).toHaveLength(0)
    tracker.inspect({ ...body, system: "different", max_tokens: 42, messages: [] })
    tracker.usage(100)
    tracker.usage(0)
  })
  expect(records.map((r) => r.kind)).toEqual([
    "cache.break.system",
    "cache.break.parameters",
    "cache.break.history",
    "cache.hit-loss",
  ])
  expect(JSON.stringify(records)).not.toContain("private")
  log.close()
})

test("family selection respects explicit catalog metadata and unknown compatible models stay generic", () => {
  expect(modelFamily({ id: "qwen3:8b", provider: "local" })).toBe("qwen")
  expect(modelFamily({ id: "claude-sonnet", provider: "proxy", promptFamily: "generic" })).toBe("generic")
  expect(modelFamily({ id: "unfamiliar", provider: "compatible" })).toBe("generic")
})

test("operation telemetry detects literal tools without retaining source or matching echoed command text", () => {
  expect(
    classifyCommand(
      "printf 'git push secret' && git -C /private/repo commit -m secret && gh pr create && semgrep scan",
    ),
  ).toEqual(["git.commit", "git.pr-create", "index.semgrep"])
  expect(classifyCommand("echo git push")).toEqual([])
  expect(classifyInvocation(["C:\\Program Files\\Git\\git.exe", "-C", "C:\\repo", "commit"])).toEqual([
    "git.commit",
  ])
  expect(classifyCommand("git $(cat secret)")).toEqual([])
  const records: DiagnosticRecord[] = [],
    log = new Diagnostics(undefined, (r) => records.push(r))
  diagnosticContext.run(log, () => recordToolOperation("bash", { command: "git push secret-remote" }))
  expect(records[0]?.kind).toBe("git.push")
  expect(JSON.stringify(records)).not.toContain("secret")
  log.close()
})

test("startup phases retain failure state without serializing exception messages", async () => {
  const records: unknown[] = [],
    detach = attachStartupTiming((r) => records.push(r))
  try {
    await expect(
      measureStartup("startup.configuration", () => {
        throw new Error("private-token")
      }),
    ).rejects.toThrow()
    expect(records).toContainEqual(expect.objectContaining({ kind: "startup.configuration", failed: 1 }))
    expect(JSON.stringify(records)).not.toContain("private-token")
  } finally {
    detach()
  }
})
