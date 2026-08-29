import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type DebugPromptSurface,
  parseDebugPromptArguments,
  runDebugCommand,
  runDebugPromptCommand,
} from "../../src/commands/debug-prompt.ts"
import { UsageError } from "../../src/commands/usage-error.ts"

class Sink {
  text = ""

  write(chunk: string): boolean {
    this.text += chunk
    return true
  }
}

const cleanups: string[] = []

afterAll(async () => {
  for (const path of cleanups) await rm(path, { recursive: true, force: true })
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(dir)
  return dir
}

type Fixture = {
  projectDir: string
  env: NodeJS.ProcessEnv
  stdout: Sink
  stderr: Sink
}

async function makeFixture(env: Record<string, string> = {}): Promise<Fixture> {
  return {
    projectDir: await makeTempDir("codesplash-debug-project-"),
    env: {
      CODESPLASH_AGENT_CONFIG_DIR: await makeTempDir("codesplash-debug-config-"),
      ANTHROPIC_API_KEY: "test-not-a-real-key",
      ...env,
    },
    stdout: new Sink(),
    stderr: new Sink(),
  }
}

function surfaceFrom(stdout: Sink): DebugPromptSurface {
  return JSON.parse(stdout.text) as DebugPromptSurface
}

describe("parseDebugPromptArguments", () => {
  test("parses path, model, and every sandbox mode including danger-full-access", () => {
    expect(parseDebugPromptArguments([])).toEqual({ path: undefined, model: undefined, sandbox: undefined })
    expect(parseDebugPromptArguments(["/tmp/x", "--model", "m:low", "--sandbox", "read-only"])).toEqual({
      path: "/tmp/x",
      model: "m:low",
      sandbox: "read-only",
    })
    expect(parseDebugPromptArguments(["--sandbox=danger-full-access"]).sandbox).toBe("danger-full-access")
  })

  test("rejects bad sandbox values, missing model values, unknown flags, and extra paths", () => {
    expect(() => parseDebugPromptArguments(["--sandbox", "chroot"])).toThrow(UsageError)
    expect(() => parseDebugPromptArguments(["--model"])).toThrow(UsageError)
    expect(() => parseDebugPromptArguments(["--frobnicate"])).toThrow(UsageError)
    expect(() => parseDebugPromptArguments(["a", "b"])).toThrow(UsageError)
  })
})

describe("runDebugCommand dispatch", () => {
  test("routes the prompt topic and refuses missing or unknown topics", async () => {
    const fixture = await makeFixture()
    expect(await runDebugCommand(["prompt", fixture.projectDir], fixture)).toBe(0)
    expect(surfaceFrom(fixture.stdout).model).toBe("claude-fable-5")

    await expect(runDebugCommand([], fixture)).rejects.toThrow(UsageError)
    await expect(runDebugCommand(["network"], fixture)).rejects.toThrow(UsageError)
  })
})

describe("runDebugPromptCommand", () => {
  test("prints the model-visible surface as one JSON object", async () => {
    const fixture = await makeFixture()

    const exitCode = await runDebugPromptCommand([fixture.projectDir], fixture)

    expect(exitCode).toBe(0)
    expect(fixture.stderr.text).toBe("")
    const surface = surfaceFrom(fixture.stdout)
    expect(surface.model).toBe("claude-fable-5")
    expect(surface.system).toContain("CodeSplash Agent")
    expect(surface.system).toContain(`Working directory: ${fixture.projectDir}`)

    const names = surface.tools.map((tool) => tool.name)
    for (const expected of ["read_file", "write_file", "edit_file", "glob", "grep", "bash", "ask_user"]) {
      expect(names).toContain(expected)
    }
    for (const tool of surface.tools) {
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.inputSchema).toBeInstanceOf(Object)
    }
    // The system prompt names every tool the surface lists.
    for (const name of names) expect(surface.system).toContain(name)
  })

  test("never leaks the API key value into the surface", async () => {
    const fixture = await makeFixture()
    await runDebugPromptCommand([fixture.projectDir], fixture)
    expect(fixture.stdout.text).not.toContain("test-not-a-real-key")
    expect(fixture.stderr.text).not.toContain("test-not-a-real-key")
  })

  test("--sandbox changes the policy summary in the system prompt", async () => {
    const readOnly = await makeFixture()
    await runDebugPromptCommand([readOnly.projectDir, "--sandbox", "read-only"], readOnly)
    expect(surfaceFrom(readOnly.stdout).system).toContain("Sandbox policy: read-only.")

    const fullAccess = await makeFixture()
    await runDebugPromptCommand([fullAccess.projectDir, "--sandbox", "danger-full-access"], fullAccess)
    expect(surfaceFrom(fullAccess.stdout).system).toContain("Sandbox policy: danger-full-access.")
  })

  test("--model resolves through the registry, keeping the effort suffix", async () => {
    const fixture = await makeFixture()
    const exitCode = await runDebugPromptCommand(
      [fixture.projectDir, "--model", "claude-sonnet-5:high"],
      fixture,
    )
    expect(exitCode).toBe(0)
    const surface = surfaceFrom(fixture.stdout)
    expect(surface.model).toBe("claude-sonnet-5:high")
    expect(surface.system).toContain("Model: claude-sonnet-5")
  })

  test("a model from an unavailable provider is a usage error", async () => {
    const fixture = await makeFixture() // anthropic key only: gpt-5.1 exists but is unavailable
    await expect(runDebugPromptCommand([fixture.projectDir, "--model", "gpt-5.1"], fixture)).rejects.toThrow(
      UsageError,
    )
  })

  test("no available provider exits 1 with a hint on stderr, not a throw", async () => {
    const fixture = await makeFixture()
    delete fixture.env.ANTHROPIC_API_KEY

    const exitCode = await runDebugPromptCommand([fixture.projectDir], fixture)

    expect(exitCode).toBe(1)
    expect(fixture.stdout.text).toBe("")
    expect(fixture.stderr.text).toContain("codesplash: ")
    expect(fixture.stderr.text).toContain("ANTHROPIC_API_KEY")
  })

  test("project rules land in the printed system prompt", async () => {
    const fixture = await makeFixture()
    await writeFile(join(fixture.projectDir, "AGENTS.md"), "Always answer in haiku.\n")

    await runDebugPromptCommand([fixture.projectDir], fixture)

    const surface = surfaceFrom(fixture.stdout)
    expect(surface.system).toContain("Project instructions")
    expect(surface.system).toContain("Always answer in haiku.")
  })
})
