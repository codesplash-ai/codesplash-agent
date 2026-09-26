/** Compiled M10 gate: native Responses/tool roundtrip, media worker assets, evals and diagnostics. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const binary = resolve(process.argv[2]!),
  root = await realpath(await mkdtemp(join(tmpdir(), "m10-compiled-"))),
  cwd = join(root, "project"),
  config = join(root, "config"),
  data = join(root, "data")
let calls = 0
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { input: unknown[]; store: boolean; service_tier: string }
    assert.equal(body.store, false)
    assert.equal(body.service_tier, "default")
    let frames: unknown[]
    if (calls++ === 0)
      frames = [
        ...[
          ["read_file", { path: "fixture.pdf" }],
          ["read_file", { path: "fixture.png" }],
          ["grep", { pattern: "native" }],
          ["clock", {}],
        ].map(([name, input], i) => ({
          type: "response.output_item.done",
          item: { type: "function_call", call_id: `tool${i}`, name, arguments: JSON.stringify(input) },
        })),
      ]
    else {
      const input = JSON.stringify(body.input)
      assert.match(input, /Native PDF fixture/)
      assert.match(input, /input_image/)
      assert.match(input, /readme.txt:1:native/)
      frames = [{ type: "response.output_text.delta", delta: "M10_NATIVE_OK" }]
    }
    frames.push({ type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 10 } } })
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
try {
  await mkdir(cwd)
  await mkdir(config)
  const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ],
    stream = "BT /F1 12 Tf 20 100 Td (Native PDF fixture) Tj ET"
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  for (const [i, obj] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  await writeFile(join(cwd, "fixture.pdf"), pdf)
  await writeFile(
    join(cwd, "fixture.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=",
      "base64",
    ),
  )
  await writeFile(join(cwd, "readme.txt"), "native")
  await writeFile(
    join(config, "config.toml"),
    `[memory]\nenabled=false\n[providers.m10]\nprotocol="openai"\napi="responses"\nserviceTier="default"\nbaseUrl=${JSON.stringify(server.url.origin)}\nrequiresKey=false\nkeyEnvVar="M10_UNUSED"\n[[providers.m10.models]]\nid="m10-fixture"\ncontextWindow=32768\nmaxOutputTokens=512\n`,
  )
  const env = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: data,
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    CODESPLASH_OTLP_ENABLED: "0",
    CODESPLASH_ANALYTICS_ENABLED: "0",
  }
  async function run(args: string[]) {
    const result = await runProcess([binary, ...args], {
      cwd,
      env,
      signal: new AbortController().signal,
      timeoutMs: 60000,
      maxBytes: 1024 * 1024,
    })
    assert.equal(result.exitCode, 0, result.stdout + result.stderr)
    return result.stdout
  }
  assert.match(await run(["tools", "doctor"]), /ripgrep-universal/)
  assert.match(
    await run([
      "run",
      "--model",
      "m10-fixture",
      "--features",
      "clock",
      "--trust",
      "--auto",
      "-p",
      "Read fixture files",
    ]),
    /M10_NATIVE_OK/,
  )
  assert.equal(calls, 2)
  const trace = join(root, "trace.json")
  await run(["trace", "export", trace])
  assert.match(await run(["trace", "replay", trace]), /provider.end/)
  assert.match(await run(["eval", "--fixture"]), /"accepted": true/)
  console.log("M10_SMOKE_OK: compiled Responses, image/PDF, search, clock, trace, native evals")
} finally {
  server.stop(true)
  await rm(root, { recursive: true, force: true })
}
