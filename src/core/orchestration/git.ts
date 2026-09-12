import { spawn } from "bun"

/** Fixed native Git plumbing; never consult credential helpers, hooks, pagers or fsmonitor. */
export async function git(
  cwd: string,
  args: string[],
  input?: Uint8Array | string,
  extra: Record<string, string> = {},
): Promise<Buffer> {
  const child = spawn(
    [
      "/usr/bin/git",
      "--no-pager",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "submodule.recurse=false",
      "-C",
      cwd,
      ...args,
    ],
    {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_AUTHOR_NAME: "CodeSplash",
        GIT_AUTHOR_EMAIL: "local@codesplash.invalid",
        GIT_COMMITTER_NAME: "CodeSplash",
        GIT_COMMITTER_EMAIL: "local@codesplash.invalid",
        ...extra,
      },
      stdin:
        input === undefined
          ? "ignore"
          : new Response(typeof input === "string" ? input : Buffer.from(input)).body!,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000)
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Buffer[] = []
    let size = 0
    const reader = stream.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 64 * 1024 * 1024) {
          child.kill("SIGKILL")
          throw new Error("Git output exceeds 64 MiB")
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks)
  }
  try {
    const [stdout, stderr, code] = await Promise.all([read(child.stdout), read(child.stderr), child.exited])
    if (code !== 0) throw new Error(`Git ${args[0]} failed (${code}): ${stderr.toString().slice(0, 2048)}`)
    return stdout
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) {
      child.kill("SIGKILL")
      await child.exited
    }
  }
}
