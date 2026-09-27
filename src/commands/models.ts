import { networkFetch } from "../core/network.ts"
import { modelCatalog } from "../engines/codesplash/catalog.ts"
import { cachedModels, refreshModels } from "../engines/codesplash/model-cache.ts"
import { UsageError } from "./usage-error.ts"
export async function runModelsCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args
  let result: unknown
  if (!action || action === "list") result = { bundled: modelCatalog, cached: cachedModels() }
  else if (action === "refresh" && rest.length === 3 && rest[1] === "--sha256")
    result = await refreshModels(rest[0]!, rest[2]!)
  else if (["discover", "pull"].includes(action)) {
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
    if (action === "discover" && rest.length > 1) throw new UsageError("Use models discover [ORIGIN]")
    if (action === "pull" && process.env.CODESPLASH_OFFLINE === "1")
      throw new Error("Model pull is disabled offline")
    url.pathname = action === "pull" ? "/api/pull" : "/api/tags"
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
            models: (Array.isArray(value.models) ? value.models : [])
              .slice(0, 1000)
              .map((m: { name?: string; digest?: string }) => ({
                name: m.name?.slice(0, 256),
                digest: m.digest?.slice(0, 128),
              })),
            note: "Discovery is inert. Add reviewed models and limits to providers config before use.",
          }
  } else if (action === "--help") {
    process.stdout.write(
      "codesplash models list | refresh HTTPS_URL --sha256 HASH | discover [OLLAMA_ORIGIN] | pull OLLAMA_ORIGIN MODEL --apply\n",
    )
    return 0
  } else throw new UsageError("Use models --help")
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}
