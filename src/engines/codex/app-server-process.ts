import { redactSensitiveText } from "../../core/redaction.ts"
import { JsonRpcConnection, type JsonRpcConnectionOptions, type JsonRpcTransport } from "./json-rpc.ts"

export type CodexAppServerProcessOptions = {
  binary?: string
  command?: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  connection?: JsonRpcConnectionOptions
  maxStderrBytes?: number
  shutdownTimeoutMs?: number
}

export type CodexAppServerProcess = {
  connection: JsonRpcConnection
  exited: Promise<number>
  getStderr(): string
  close(): Promise<void>
}

const DEFAULT_STDERR_BYTES = 64 * 1024
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_500

export function spawnCodexAppServer(options: CodexAppServerProcessOptions = {}): CodexAppServerProcess {
  const binary = options.binary ?? "codex"
  const command = options.command ?? [binary, "app-server", "--stdio"]
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  const stderr = collectBoundedText(child.stderr, options.maxStderrBytes ?? DEFAULT_STDERR_BYTES)
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  let closing: Promise<void> | undefined

  const closeChild = (): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      child.stdin.end()
      if (await exitsWithin(child.exited, shutdownTimeoutMs)) return

      child.kill("SIGTERM")
      if (await exitsWithin(child.exited, shutdownTimeoutMs)) return

      child.kill("SIGKILL")
      await child.exited
    })()
    return closing
  }

  const transport: JsonRpcTransport = {
    chunks: readStream(child.stdout),
    async write(line) {
      child.stdin.write(line)
      await child.stdin.flush()
    },
    close: closeChild,
  }

  const connection = new JsonRpcConnection(transport, options.connection)

  return {
    connection,
    exited: child.exited,
    getStderr: () => redactSensitiveText(stderr.text, { ...process.env, ...options.env }),
    close: () => connection.close(),
  }
}

async function* readStream(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader()
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) return
      yield result.value
    }
  } finally {
    reader.releaseLock()
  }
}

function collectBoundedText(stream: ReadableStream<Uint8Array>, maxBytes: number): { text: string } {
  const state = { text: "" }
  const decoder = new TextDecoder()
  let collected = 0

  void (async () => {
    for await (const chunk of readStream(stream)) {
      if (collected >= maxBytes) continue
      const available = Math.min(chunk.byteLength, maxBytes - collected)
      state.text += decoder.decode(chunk.subarray(0, available), { stream: true })
      collected += available
    }
    state.text += decoder.decode()
  })()

  return state
}

async function exitsWithin(exited: Promise<number>, timeoutMs: number): Promise<boolean> {
  return Promise.race([exited.then(() => true), Bun.sleep(timeoutMs).then(() => false)])
}
