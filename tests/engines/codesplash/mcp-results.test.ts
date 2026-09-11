import { expect, test } from "bun:test"
import { materializeMcpResult } from "../../../src/engines/codesplash/mcp/results.ts"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg=="
const source = { server: "fixture", generation: "generation", operation: "read" }
const sanitize = (text: string) => text.replaceAll("fixture-secret", "[REDACTED]")

test("MCP results retain provenance, structured content, binary MIME and validated images", async () => {
  const result = await materializeMcpResult(
    {
      content: [
        { type: "text", text: "fixture-secret response" },
        { type: "image", mimeType: "image/png", data: png },
        {
          type: "resource",
          resource: {
            uri: "file:///not-a-local-read",
            mimeType: "application/octet-stream",
            blob: Buffer.from("fixture binary").toString("base64"),
          },
        },
      ],
      structuredContent: { retained: [1, 2, "fixture-secret"] },
    },
    source,
    sanitize,
    AbortSignal.timeout(1000),
  )
  const retained = JSON.parse(result.text)
  expect(retained.source).toEqual(source)
  expect(retained.result.content[0].text).toBe("[REDACTED] response")
  expect(retained.result.structuredContent).toEqual({ retained: [1, 2, "[REDACTED]"] })
  expect(retained.result.content[2].resource.mimeType).toBe("application/octet-stream")
  expect(retained.result.content[2].resource.blob).toBe(Buffer.from("fixture binary").toString("base64"))
  expect(result.images).toEqual([{ type: "image", mediaType: "image/png", base64Data: png }])
  expect(result.text).not.toContain(png)
  const resource = await materializeMcpResult(
    { contents: [{ uri: "fixture://image", mimeType: "image/png", blob: png }] },
    source,
    sanitize,
    AbortSignal.timeout(1000),
  )
  expect(resource.images).toHaveLength(1)
  expect(JSON.parse(resource.text).result.contents[0].uri).toBe("fixture://image")
})

test("MCP result limits reject excessive images, MIME substitution and binary credentials", async () => {
  const run = (content: unknown[]) =>
    materializeMcpResult({ content }, source, sanitize, AbortSignal.timeout(1000))
  await expect(
    run(Array.from({ length: 9 }, () => ({ type: "image", mimeType: "image/png", data: png }))),
  ).rejects.toThrow("image limit")
  await expect(run([{ type: "image", mimeType: "image/jpeg", data: png }])).rejects.toThrow("MIME mismatch")
  await expect(
    run([
      {
        type: "resource",
        resource: { uri: "fixture://secret", blob: Buffer.from("fixture-secret").toString("base64") },
      },
    ]),
  ).rejects.toThrow("credential")
  await expect(run([{ type: "audio", mimeType: "audio/wav", data: "YQ=" }])).rejects.toThrow("base64")
})
