import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "shell-quote"
import { deferSignalExit, registerChildProcess, registerCleanup } from "../core/lifecycle.ts"

const maximumDraftBytes = 1024 * 1024

export function editorArgv(env: NodeJS.ProcessEnv): string[] {
  const source = env.VISUAL?.trim() || env.EDITOR?.trim() || (process.platform === "win32" ? "notepad" : "vi")
  const parsed = parse(source, env)
  if (!parsed.length || parsed.some((part) => typeof part !== "string" || part.includes("\0")))
    throw new Error("VISUAL/EDITOR must contain an executable and arguments, without shell operators")
  return parsed as string[]
}

export async function editDraft(options: {
  text: string
  cwd: string
  renderer: { suspend(): void; resume(): void }
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}): Promise<string> {
  if (Buffer.byteLength(options.text) > maximumDraftBytes)
    throw new Error("Draft exceeds the 1 MiB editor limit")
  options.signal?.throwIfAborted()
  const argv = editorArgv(options.env ?? process.env)
  const directory = await mkdtemp(join(tmpdir(), "codesplash-editor-"))
  const path = join(directory, "draft.md")
  let suspended = false
  let releaseSignals = () => {}
  try {
    await chmod(directory, 0o700)
    await writeFile(path, options.text, { mode: 0o600 })
    options.signal?.throwIfAborted()
    options.renderer.suspend()
    suspended = true
    releaseSignals = deferSignalExit()
    await new Promise<void>((resolve, reject) => {
      const child = spawn(argv[0]!, [...argv.slice(1), path], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: "inherit",
        shell: false,
      })
      const untrack = registerChildProcess(child)
      const kill = () => {
        child.kill("SIGKILL")
      }
      const unregister = registerCleanup(kill)
      const cleanup = () => {
        untrack()
        unregister()
        options.signal?.removeEventListener("abort", kill)
      }
      options.signal?.addEventListener("abort", kill, { once: true })
      if (options.signal?.aborted) kill()
      child.once("error", (error) => {
        cleanup()
        reject(error)
      })
      child.once("exit", (code) => {
        cleanup()
        if (options.signal?.aborted) reject(new Error("Editor cancelled; draft preserved"))
        else if (code !== 0) reject(new Error(`Editor exited with ${code ?? "a signal"}; draft preserved`))
        else resolve()
      })
    })
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > maximumDraftBytes)
        throw new Error("Editor result is not a regular file within 1 MiB")
      const bytes = Buffer.alloc(maximumDraftBytes + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead > maximumDraftBytes) throw new Error("Editor result exceeds 1 MiB")
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))
    } finally {
      await file.close()
    }
  } finally {
    releaseSignals()
    if (suspended && !options.signal?.aborted) options.renderer.resume()
    await rm(directory, { recursive: true, force: true })
  }
}
