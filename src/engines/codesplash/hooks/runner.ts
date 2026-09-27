import type { PermissionMode } from "../../../core/config.ts"
import { type HookEventName, hookIsGate } from "../../../core/hooks.ts"
import { networkFetch } from "../../../core/network.ts"
import type { SandboxRuntime } from "../sandbox/contracts.ts"
import { startNetworkBroker } from "../sandbox/network-broker.ts"
import { canonicalHost } from "../sandbox/profile.ts"
import type { HookReview } from "./trust.ts"

const BYTES = 128 * 1024
/** No retries: even an unreadable response may follow an external effect. */
export async function runHookHandler(options: {
  review: HookReview
  event: HookEventName
  input: string
  sandbox: SandboxRuntime
  mode: PermissionMode
  signal: AbortSignal
  bearer?: string
}): Promise<unknown> {
  const { review, sandbox, signal, mode } = options
  const handler = review.config
  signal.throwIfAborted()
  if (Buffer.byteLength(options.input) > BYTES) throw new Error("Hook input exceeds 128 KiB")
  let output: string
  if (handler.kind === "command") {
    if (!sandbox.executeFixed || !review.argv) throw new Error("Fixed hook sandbox is unavailable")
    const result = await sandbox.executeFixed(review.argv, options.input, signal, {
      mode,
      environment: handler.environment ?? [],
      timeoutMs: handler.timeoutMs,
      writeWorkspace: handler.writeWorkspace,
    })
    signal.throwIfAborted()
    if (result.kind === "command-failure" && result.exitCode === 2 && hookIsGate(options.event))
      return { version: 1, decision: "deny", reason: "Handler refused this operation (exit 2)" }
    if (result.kind !== "success" || result.exitCode !== 0)
      throw new Error(`Hook command failed (${result.kind}, exit ${result.exitCode})`)
    output = result.stdout
  } else {
    // An arbitrary HTTP POST has unknown remote effects; local read-only enforcement cannot contain it.
    if (mode === "plan" || sandbox.profile.mode === "read-only")
      throw new Error("HTTP hooks require a mode permitting external effects")
    const endpoint = new URL(handler.url ?? "")
    const loopback = handler.allowLoopback && ["127.0.0.1", "[::1]"].includes(endpoint.hostname)
    if (
      !loopback &&
      !sandbox.profile.allowedHosts.includes(canonicalHost(`${endpoint.hostname}:${endpoint.port || "443"}`))
    )
      throw new Error("Hook endpoint requires a fixed sandbox network grant")
    const broker = await startNetworkBroker(sandbox.profile.allowedHosts, {
      ...(loopback ? { loopbackOrigins: [endpoint.origin] } : {}),
    })
    const cancel = () => broker.close()
    signal.addEventListener("abort", cancel, { once: true })
    try {
      signal.throwIfAborted()
      const response = await networkFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
        },
        body: options.input,
        proxy: broker.url,
        redirect: "manual",
        signal,
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Hook HTTP response ${response.status}; redirects and retries are refused`)
      }
      const chunks: Uint8Array[] = []
      let size = 0
      const reader = response.body?.getReader()
      try {
        if (reader)
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > BYTES || chunks.length >= 8192) throw new Error("Hook output exceeds 128 KiB")
            chunks.push(chunk.value)
          }
      } finally {
        await reader?.cancel().catch(() => {})
        reader?.releaseLock()
      }
      output = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))
    } finally {
      signal.removeEventListener("abort", cancel)
      broker.close()
    }
  }
  signal.throwIfAborted()
  if (Buffer.byteLength(output) > BYTES) throw new Error("Hook output exceeds 128 KiB")
  try {
    return output.trim() ? JSON.parse(output) : { version: 1 }
  } catch {
    throw new Error("Hook output is not valid JSON")
  }
}
