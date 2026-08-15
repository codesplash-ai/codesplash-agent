#!/usr/bin/env bun

function printHelp() {
  process.stdout.write(`CodeSplash Agent

Usage:
  agent [path]
  agent --fixture
  agent --codex-smoke
  agent --codex-live-smoke
  agent --claude-handoff-smoke
  agent --help

Options:
  path           Project directory (defaults to the current directory)
  --fixture      Render the synthetic OpenTUI development fixture
  --codex-smoke  Check Codex app-server startup, protocol, and account state without running a model
  --codex-live-smoke
                 Use model quota to exercise approval, interrupt, resume, and a second turn
  --claude-handoff-smoke
                 Hand the real terminal to Claude Code for a quota-free version check
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.includes("--help") || args.includes("-h")) {
    printHelp()
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

  const unknownOption = args.find((argument) => argument.startsWith("-"))
  if (unknownOption) throw new Error(`Unknown option ${unknownOption}`)
  if (args.length > 1) throw new Error("Expected at most one project path")

  const { inspectProject } = await import("./core/preflight.ts")
  const project = await inspectProject(args[0] ?? process.cwd())
  const { runWelcome } = await import("./tui/run-welcome.tsx")
  await runWelcome(project)
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`agent: ${message}\n`)
  process.exitCode = 1
}
