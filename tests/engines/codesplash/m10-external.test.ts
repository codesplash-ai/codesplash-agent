import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig } from "../../../src/core/config.ts"
import type { ToolContext } from "../../../src/engines/codesplash/contracts.ts"
import { stagePackage } from "../../../src/engines/codesplash/plugins/store.ts"
import { createProfile, physicalPath } from "../../../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../../../src/engines/codesplash/sandbox/runtime.ts"
import { codeModeTool } from "../../../src/engines/codesplash/tools/advanced.ts"
import { BrowserTools } from "../../../src/engines/codesplash/tools/browser.ts"
import { environmentTool, validateEnvironments } from "../../../src/engines/codesplash/tools/environments.ts"
import { GenerationTools, generationArtifact } from "../../../src/engines/codesplash/tools/generation.ts"
import { grepTool } from "../../../src/engines/codesplash/tools/grep.ts"
import { pluginSuggestions } from "../../../src/engines/codesplash/tools/plugin-suggestions.ts"
import { readFileTool } from "../../../src/engines/codesplash/tools/read.ts"
import { createAgentSession, type ExtensionProvider } from "../../../src/sdk/index.ts"

const context = (cwd: string): ToolContext => ({
  cwd,
  policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
  signal: new AbortController().signal,
})

test("generation creates durable image/video jobs, exports bytes, and never retries uncertain POSTs", async () => {
  const root = mkdtempSync(join(tmpdir(), "m10-generation-")),
    png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=",
      "base64",
    ),
    mp4 = Buffer.from([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109])
  let requests = 0,
    failed = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      requests++
      if (failed) return new Response("failed", { status: 503 })
      const path = new URL(req.url).pathname
      if (path.endsWith("/video.mp4")) return new Response(mp4)
      if (path.endsWith("/images/generations"))
        return Response.json({ data: [{ b64_json: png.toString("base64") }] })
      return Response.json({
        id: "00000000-0000-0000-0000-000000000001",
        status: req.method === "POST" ? "PENDING" : "SUCCEEDED",
        output: [`${server.url.origin}/video.mp4`],
      })
    },
  })
  const cfg = {
      baseUrl: `${server.url.origin}/v1`,
      videoBaseUrl: `${server.url.origin}/v1`,
      imageModel: "fixture-image",
      videoModel: "fixture-video",
      apiKeyEnv: "M10_FIXTURE_KEY",
      maxJobs: 3,
    },
    tools = new GenerationTools(root, [], cfg)
  try {
    const image = JSON.parse(
      (await tools.run({ action: "create", kind: "image", prompt: "test" }, context(root))).text,
    )
    expect(generationArtifact(root, image.id).content).toEqual(png)
    const video = JSON.parse(
      (await tools.run({ action: "create", kind: "video", prompt: "test" }, context(root))).text,
    )
    await tools.run({ action: "status", job: video.id }, context(root))
    await tools.run({ action: "download", job: video.id }, context(root))
    expect(generationArtifact(root, video.id).content).toEqual(mp4)
    const before = requests
    failed = true
    await expect(
      tools.run({ action: "create", kind: "image", prompt: "test" }, context(root)),
    ).rejects.toThrow("no retry")
    expect(requests - before).toBe(1)
    expect(readdirSync(root).filter((p) => p.endsWith(".json"))).toHaveLength(3)
    await expect(
      new GenerationTools(root, [], cfg).run(
        { action: "create", kind: "image", prompt: "test" },
        context(root),
      ),
    ).rejects.toThrow("limit")
  } finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)
test("code mode and local environment use the native boundary; vendored search retains permission filtering", async () => {
  const root = physicalPath(mkdtempSync(join(tmpdir(), "m10-native-tools-"))),
    runtime = new NativeSandbox(createProfile(root, "workspace-write")),
    ctx = context(root)
  try {
    writeFileSync(
      join(root, "large.png"),
      Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(2 * 1024 * 1024)]),
    )
    const image = await runtime.runTool(readFileTool, { path: "large.png" }, ctx)
    expect(image.images?.[0]?.base64Data.length).toBeGreaterThan(2 * 1024 * 1024)
    const code = await runtime.runTool(
      codeModeTool,
      { code: 'await Bun.write("result.txt", "native"); return 42' },
      ctx,
    )
    expect(code, JSON.stringify(code)).toMatchObject({ text: "42" })
    const denied = await runtime.runTool(
      codeModeTool,
      { code: 'await Bun.write(".codesplash/config.toml", "bad")' },
      ctx,
    )
    expect(denied.isError).toBe(true)
    const env = environmentTool([{ id: "local", transport: "local" }], runtime)
    expect((await env.run({ environment: "local", command: "cat result.txt" }, ctx)).text).toContain("native")
    expect((await runtime.runTool(grepTool, { pattern: "native" }, ctx)).text).toContain(
      "result.txt:1:native",
    )
    expect(() =>
      validateEnvironments([
        { id: "bad", transport: "container", image: "alpine:latest", executable: "/usr/bin/docker" },
      ]),
    ).toThrow("digest")
  } finally {
    await runtime.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 60000)
const chrome =
  process.env.CODESPLASH_BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
test.skipIf(!existsSync(chrome))(
  "isolated browser traverses only explicit origins and closes on cancellation",
  async () => {
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
          new Response(
            `<html><body><input id="name"><button id="go" onclick="document.querySelector('output').textContent=document.querySelector('input').value">Submit</button><output>Ready</output></body></html>`,
            { headers: { "content-type": "text/html" } },
          ),
      }),
      browser = new BrowserTools([], [server.url.origin], chrome),
      browserRoot = physicalPath(mkdtempSync(join(tmpdir(), "m10-browser-native-"))),
      runtime = new NativeSandbox(createProfile(browserRoot, "workspace-write")),
      ctx = { ...context(browserRoot), checkNetwork: runtime.checkNetwork }
    try {
      expect((await browser.tool().run({ action: "open", url: server.url.href }, ctx)).text).toContain(
        "Ready",
      )
      await browser.tool().run({ action: "type", selector: "#name", text: "M10" }, ctx)
      await browser.tool().run({ action: "click", selector: "#go" }, ctx)
      expect((await browser.tool().run({ action: "snapshot" }, ctx)).text).toContain("M10")
      expect((await browser.tool().run({ action: "screenshot" }, ctx)).images?.[0]?.mediaType).toBe(
        "image/png",
      )
      await expect(
        browser.tool().run({ action: "open", url: "https://example.invalid/" }, ctx),
      ).rejects.toThrow("allowlist")
      const controller = new AbortController()
      const pending = browser
        .tool()
        .run({ action: "click", selector: "#missing" }, { ...ctx, signal: controller.signal })
      setTimeout(() => controller.abort(), 30)
      await expect(pending).rejects.toThrow()
      await expect(browser.tool().run({ action: "snapshot" }, ctx)).rejects.toThrow("closed")
    } finally {
      await browser.close()
      await runtime.close()
      rmSync(browserRoot, { recursive: true, force: true })
      server.stop(true)
    }
  },
  30000,
)

test("native generation dispatch enforces explicit approval before any HTTP request", async () => {
  const root = physicalPath(mkdtempSync(join(tmpdir(), "m10-sdk-media-")))
  let requests = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests++
      return Response.json({
        data: [{ b64_json: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") }],
      })
    },
  })
  const env = {
      CODESPLASH_GENERATION_BASE_URL: server.url.origin + "/v1",
      CODESPLASH_IMAGE_MODEL: "fixture",
      CODESPLASH_GENERATION_KEY_ENV: "M10_FIXTURE_KEY",
    },
    old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  try {
    for (const approve of [false, true]) {
      let turns = 0,
        approvals = 0
      const provider: ExtensionProvider = {
        name: "media",
        displayName: "Fixture",
        protocol: "openai",
        models: [
          {
            id: "fixture",
            displayName: "Fixture",
            contextWindow: 32768,
            maxOutputTokens: 100,
            isDefault: true,
            supportsReasoning: false,
          },
        ],
        async *stream(request) {
          expect(request.tools.some((tool) => tool.name === "generate_media")).toBe(true)
          if (turns++ === 0) {
            yield {
              type: "tool_call",
              id: "generate",
              name: "generate_media",
              input: { action: "create", kind: "image", prompt: "fixture" },
            }
            yield { type: "done", stopReason: "tool_use" }
            return
          }
          const output = request.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result")
          expect(output?.type === "tool_result" && !!output.isError).toBe(!approve)
          yield { type: "text_delta", text: "MEDIA_APPROVAL_OK" }
          yield { type: "done", stopReason: "end_turn" }
        },
      }
      const session = await createAgentSession({
        cwd: root,
        trustDataDirectory: join(root, "data"),
        workspaceTrusted: true,
        config: { path: join(root, "empty.toml"), overrides: ["memory.enabled=false"] },
        model: "ext_sdk_media/fixture",
        providers: [provider],
        execution: { features: ["generation"] },
        respond: async (request) => {
          expect(request.alwaysAsk).toBe(true)
          approvals++
          return { choice: approve ? "accept" : "decline" }
        },
      })
      try {
        expect((await session.prompt("Exercise generation approval")).status).toBe("completed")
        expect(approvals).toBe(1)
        expect(requests).toBe(approve ? 1 : 0)
      } finally {
        await session.close()
      }
    }
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 30000)

test("plugin suggestions inspect verified local catalogs without installing or executing", async () => {
  const root = physicalPath(mkdtempSync(join(tmpdir(), "m10-suggestions-"))),
    source = join(root, "market")
  mkdirSync(source)
  try {
    writeFileSync(
      join(source, "codesplash-marketplace.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "market",
        plugins: { pdf: { source: "npm:fictional-pdf-fixture@1.0.0", description: "PDF inspection" } },
      }),
    )
    const staged = await stagePackage(join(root, "data"), source, "marketplace"),
      config = structuredClone(defaultConfig)
    config.plugins = { entries: {}, marketplaces: { market: staged.selection } }
    const tool = pluginSuggestions(() => config)
    expect(JSON.parse((await tool.run({ query: "pdf" }, context(root))).text).suggestions[0].id).toBe("pdf")
    expect(config.plugins.entries).toEqual({})
    writeFileSync(join(staged.selection.root, "codesplash-marketplace.json"), "corrupt")
    await expect(tool.run({ query: "pdf" }, context(root))).rejects.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
