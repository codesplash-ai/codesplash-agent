import { networkFetch, responseBytes } from "../core/network.ts"
import { modelCatalog } from "../engines/codesplash/catalog.ts"
import { cachedModels, refreshModels } from "../engines/codesplash/model-cache.ts"
import { UsageError } from "./usage-error.ts"
export async function runModelsCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args
  let result: unknown
  if (!action || action === "list") result = { bundled: modelCatalog, cached: cachedModels() }
  else if (action === "refresh" && rest.length === 3 && rest[1] === "--sha256")
    result = await refreshModels(rest[0]!, rest[2]!)
  else if (["discover", "discover-compatible", "pull"].includes(action)) {
    const url = new URL(rest[0] ?? "http://127.0.0.1:11434")
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new UsageError("Local runtime requires a loopback HTTP origin")
    if (action === "pull" && (rest.length !== 3 || rest[2] !== "--apply" || !rest[1] || rest[1].length > 256))
      throw new UsageError("Use models pull ORIGIN MODEL --apply")
    if (action !== "pull" && rest.length > 1) throw new UsageError("Use models discover [ORIGIN]")
    if (action === "pull" && process.env.CODESPLASH_OFFLINE === "1")
      throw new Error("Model pull is disabled offline")
    url.pathname =
      action === "pull" ? "/api/pull" : action === "discover-compatible" ? "/v1/models" : "/api/tags"
    const response = await networkFetch(url, {
      method: action === "pull" ? "POST" : "GET",
      ...(action === "pull"
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: rest[1], stream: false }),
          }
        : {}),
      redirect: "error",
      signal: AbortSignal.timeout(action === "pull" ? 300000 : 5000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Local runtime HTTP ${response.status}`)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Local runtime body missing")
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.length
        if (size > 1024 * 1024) throw new Error("Runtime result too large")
        chunks.push(part.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    const value = JSON.parse(Buffer.concat(chunks).toString())
    result =
      action === "pull"
        ? { status: value.status }
        : {
            models: (Array.isArray(value.models) ? value.models : Array.isArray(value.data) ? value.data : [])
              .slice(0, 1000)
              .map((m: { name?: string; id?: string; digest?: string }) => ({
                name: (m.name ?? m.id)?.slice(0, 256),
                digest: m.digest?.slice(0, 128),
              })),
            note: "Discovery is inert. Add reviewed models and limits to providers config before use.",
          }
  } else if (action === "install-runtime") {
    if (
      rest.length !== 5 ||
      rest[2] !== "--sha256" ||
      rest[4] !== "--apply" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(rest[0] ?? "") ||
      !/^[a-f0-9]{64}$/.test(rest[3] ?? "")
    )
      throw new UsageError("Use models install-runtime NAME HTTPS_EXECUTABLE --sha256 HASH --apply")
    const url = new URL(rest[1]!)
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new UsageError("Runtime installation requires an exact reviewed HTTPS executable")
    const { join } = await import("node:path"),
      { chmodSync, existsSync } = await import("node:fs"),
      { dataDirectory } = await import("../core/config.ts"),
      { atomic, digest, directory, lease, bytes } = await import("../core/session/files.ts")
    const root = join(dataDirectory(), "local-runtimes", rest[0]!, rest[3]!),
      path = join(root, process.platform === "win32" ? "runtime.exe" : "runtime")
    const response = await networkFetch(url, { redirect: "error", signal: AbortSignal.timeout(120000) })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Runtime download HTTP ${response.status}`)
    }
    const source = await responseBytes(response, 256 * 1024 * 1024)
    if (digest(source) !== rest[3]) throw new Error("Runtime executable checksum mismatch")
    directory(root, true)
    const release = lease(root, "install.lease")
    try {
      if (existsSync(path) && digest(bytes(path, 256 * 1024 * 1024)) !== rest[3])
        throw new Error("Existing runtime is corrupt")
      if (!existsSync(path)) atomic(path, source)
      chmodSync(path, 0o700)
      atomic(
        join(root, "receipt.json"),
        JSON.stringify({
          version: 1,
          url: url.href,
          sha256: rest[3],
          platform: process.platform,
          arch: process.arch,
        }),
      )
    } finally {
      release()
    }
    result = {
      path,
      sha256: rest[3],
      note: "Installed a reviewed single executable; launch/configure it explicitly. No model downloaded or executable started.",
    }
  } else if (action === "--help") {
    process.stdout.write(
      "codesplash models list | refresh HTTPS_URL --sha256 HASH | discover [OLLAMA_ORIGIN] | discover-compatible ORIGIN | install-runtime NAME HTTPS_EXECUTABLE --sha256 HASH --apply | pull OLLAMA_ORIGIN MODEL --apply\n",
    )
    return 0
  } else throw new UsageError("Use models --help")
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}
