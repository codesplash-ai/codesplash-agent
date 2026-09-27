import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { networkFetch } from "../../src/core/network.ts"
import { runProcess } from "../../src/engines/codesplash/sandbox/process.ts"
import { connectThroughProxy } from "../../src/engines/codesplash/sandbox/proxy-tunnel.ts"

test("real TLS requires trusted CA and still checks hostname", async () => {
  const root = await mkdtemp(join(tmpdir(), "m11-tls-"))
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    await writeFile(
      join(root, "cert.cnf"),
      "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\nsubjectAltName=DNS:localhost\n",
    )
    const cert = Bun.spawnSync(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-config",
        join(root, "cert.cnf"),
        "-keyout",
        join(root, "key.pem"),
        "-out",
        join(root, "ca.pem"),
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    expect(cert.exitCode, cert.stderr.toString()).toBe(0)
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: Bun.file(join(root, "key.pem")), cert: Bun.file(join(root, "ca.pem")) },
      fetch: () => new Response("trusted"),
    })
    const url = `https://localhost:${server.port}`,
      env = { CODESPLASH_AGENT_CONFIG_DIR: root },
      trusted = { ...env, CODESPLASH_EXTRA_CA: join(root, "ca.pem"), CODESPLASH_REQUIRE_EXTRA_CA: "1" }
    await expect(networkFetch(url, undefined, { env })).rejects.toThrow()
    expect(await (await networkFetch(url, undefined, { env: trusted })).text()).toBe("trusted")
    await expect(
      networkFetch(`https://127.0.0.1:${server.port}`, undefined, { env: trusted }),
    ).rejects.toThrow()
    await expect(
      networkFetch(url, undefined, { env: { ...trusted, CODESPLASH_OFFLINE: "1" } }),
    ).rejects.toThrow("offline")
  } finally {
    server?.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

test("upstream CONNECT uses the vetted IP, proxy auth and preserves bytes after headers", async () => {
  let request = "",
    authorization: string | undefined
  const sockets = new Set<import("node:net").Socket>()
  const proxy = createServer()
  proxy.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  proxy.on("connect", (req, socket) => {
    request = req.url ?? ""
    authorization = req.headers["proxy-authorization"]
    socket.write("HTTP/1.1 200 Connection established\r\n\r\nhello")
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const address = proxy.address() as import("node:net").AddressInfo
  try {
    const socket = await connectThroughProxy("203.0.113.25", 443, {
      CODESPLASH_PROXY: `http://user:password@127.0.0.1:${address.port}`,
    })
    try {
      const output = new Promise<string>((resolve, reject) => {
        socket.once("data", (chunk) => resolve(chunk.toString()))
        socket.once("error", reject)
        socket.setTimeout(2000, () => reject(new Error("No tunneled bytes")))
      })
      socket.resume()
      expect(await output).toBe("hello")
      expect(request).toBe("203.0.113.25:443")
      expect(authorization).toBe(`Basic ${Buffer.from("user:password").toString("base64")}`)
    } finally {
      socket.destroy()
    }
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
  }
})

test("failed cleanup cannot prevent termination or leave the transport waiting", async () => {
  const result = await runProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    cwd: process.cwd(),
    env: process.env,
    signal: new AbortController().signal,
    timeoutMs: 100,
    cleanup: () => {
      throw new Error("fixture cleanup failure")
    },
  })
  expect(result.kind).toBe("unavailable")
  expect(result.exitCode).toBe(126)
  expect(result.stderr).toContain("cleanup failed")
})
