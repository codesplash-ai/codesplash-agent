import { realpath, stat } from "node:fs/promises"
import { basename, resolve } from "node:path"

export type GitPreflight = {
  available: boolean
  repository: boolean
  branch?: string
  changedFiles: number
  detail?: string
}

export type ProjectPreflight = {
  cwd: string
  name: string
  git: GitPreflight
}

/** Validate the selected project and collect quota-free Git diagnostics for the status line. */
export async function inspectProject(path: string): Promise<ProjectPreflight> {
  const requestedPath = resolve(path)
  let cwd: string
  try {
    cwd = await realpath(requestedPath)
    const metadata = await stat(cwd)
    if (!metadata.isDirectory()) throw new Error("path is not a directory")
  } catch (error) {
    throw new Error(
      `Cannot open working directory ${requestedPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }

  return { cwd, name: basename(cwd), git: await inspectGit(cwd) }
}

async function inspectGit(cwd: string): Promise<GitPreflight> {
  const binary = Bun.which("git")
  if (!binary) {
    return { available: false, repository: false, changedFiles: 0, detail: "Git is not installed" }
  }

  try {
    const child = Bun.spawn([binary, "-C", cwd, "status", "--porcelain=v1", "--branch"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    if (exitCode !== 0) {
      const detail = stderr.trim()
      const repository = !/not a git repository/i.test(detail)
      return {
        available: true,
        repository,
        changedFiles: 0,
        detail: detail || `git status exited with status ${exitCode}`,
      }
    }

    const lines = stdout.split(/\r?\n/).filter(Boolean)
    const header = lines[0]?.startsWith("## ") ? lines.shift()?.slice(3) : undefined
    const branch = header?.split("...")[0]?.replace(/^HEAD \(no branch\)$/, "detached")
    return {
      available: true,
      repository: true,
      branch,
      changedFiles: lines.length,
    }
  } catch (error) {
    return {
      available: true,
      repository: false,
      changedFiles: 0,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
