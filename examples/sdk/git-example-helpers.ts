import { spawn } from "node:child_process"
export async function exampleGit(
  cwd: string,
  args: string[],
  signal = AbortSignal.timeout(5000),
): Promise<string> {
  const nullPath = process.platform === "win32" ? "NUL" : "/dev/null"
  const child = spawn(
    "git",
    [
      "--no-pager",
      "-c",
      `core.hooksPath=${nullPath}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "submodule.recurse=false",
      ...args,
    ],
    {
      cwd,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: nullPath,
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_AUTHOR_NAME: "SDK example",
        GIT_AUTHOR_EMAIL: "example@codesplash.invalid",
        GIT_COMMITTER_NAME: "SDK example",
        GIT_COMMITTER_EMAIL: "example@codesplash.invalid",
      },
    },
  )
  let output = "",
    error = "",
    exceeded = false
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.stdout.on("data", (data) => {
      output += String(data)
      if (output.length > 65536) {
        exceeded = true
        child.kill("SIGKILL")
      }
    })
    child.stderr.on("data", (data) => {
      error += String(data)
      if (error.length > 8192) {
        exceeded = true
        child.kill("SIGKILL")
      }
    })
    child.once("close", (code) =>
      code === 0 && !exceeded
        ? resolve(output)
        : reject(new Error(`Example Git failed (${code}): ${error.slice(0, 8192)}`)),
    )
  })
}
