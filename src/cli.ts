#!/usr/bin/env bun

import type { AppOptions } from "./core/app-options.ts"

function printHelp() {
  process.stdout.write(`CodeSplash Agent

Usage:
  codesplash [path] [--no-history] [--sandbox <mode>] [--full-access]
  codesplash --doctor
  codesplash --version
  codesplash --fixture
  codesplash --codex-smoke
  codesplash --codex-live-smoke
  codesplash --claude-handoff-smoke
  codesplash --help

Options:
  path           Project directory (defaults to the current directory)
  --doctor       Print non-interactive diagnostics (runtime, engines, auth, paths) and exit
  --version      Print the application version and exit
  --no-history   Do not write session metadata or event history for this run
  --sandbox <mode>
                 Override the configured Codex sandbox: read-only or workspace-write
  --full-access  Run Codex without a sandbox after an explicit confirmation (dangerous)
  --fixture      Render the synthetic OpenTUI development fixture
  --codex-smoke  Check Codex app-server startup, protocol, and account state without running a model
  --codex-live-smoke
                 Use model quota to exercise approval, interrupt, resume, and a second turn
  --claude-handoff-smoke
                 Hand the real terminal to Claude Code for a quota-free version check
`)
}

export function parseAppArguments(args: string[]): { path?: string; options: AppOptions } {
  const options: AppOptions = { noHistory: false, fullAccess: false }
  let path: string | undefined

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] as string
    if (argument === "--no-history") {
      options.noHistory = true
    } else if (argument === "--full-access") {
      options.fullAccess = true
    } else if (argument === "--sandbox" || argument.startsWith("--sandbox=")) {
      const value = argument.includes("=") ? argument.slice("--sandbox=".length) : args[++index]
      if (value === "read-only" || value === "workspace-write") {
        options.sandboxOverride = value
      } else if (value === "danger-full-access") {
        throw new Error("Use --full-access to run without a sandbox; it requires confirmation")
      } else {
        throw new Error(`--sandbox expects read-only or workspace-write, got ${value ?? "nothing"}`)
      }
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option ${argument}`)
    } else if (path === undefined) {
      path = argument
    } else {
      throw new Error("Expected at most one project path")
    }
  }

  return { path, options }
}

async function main(): Promise<void> {
  const { installSignalHandlers } = await import("./core/lifecycle.ts")
  installSignalHandlers()

  const args = process.argv.slice(2)

  if (args.includes("--help") || args.includes("-h")) {
    printHelp()
    return
  }

  if (args.includes("--version") || args.includes("-v")) {
    const { APP_VERSION } = await import("./version.ts")
    process.stdout.write(`${APP_VERSION}\n`)
    return
  }

  if (args.includes("--doctor")) {
    const { runDoctor } = await import("./doctor.ts")
    await runDoctor()
    return
  }

  if (args.includes("--codex-smoke")) {
    const { runCodexSmoke } = await import("./engines/codex/smoke.ts")
    await runCodexSmoke()
    return
  }

  if (args.includes("--codex-live-smoke")) {
    const { runCodexLiveSmoke } = await import("./engines/codex/live-smoke.ts")
    await runCodexLiveSmoke()
    return
  }

  if (args.includes("--claude-handoff-smoke")) {
    const { ClaudeDriver } = await import("./engines/claude/index.ts")
    const result = await new ClaudeDriver().handoff(process.cwd(), ["--version"])
    if (result.exitCode !== 0) throw new Error(`Claude handoff exited with status ${result.exitCode}`)
    process.stdout.write("Claude real-terminal handoff smoke passed\n")
    return
  }

  if (args.includes("--fixture")) {
    const { runFixture } = await import("./tui/run-fixture.tsx")
    await runFixture()
    return
  }

  const { path, options } = parseAppArguments(args)

  const { inspectProject } = await import("./core/preflight.ts")
  const project = await inspectProject(path ?? process.cwd())
  const { runWelcome } = await import("./tui/run-welcome.tsx")
  await runWelcome(project, options)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`codesplash: ${message}\n`)
    process.exitCode = 1
  }
}
