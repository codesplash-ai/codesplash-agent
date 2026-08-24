import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import packageJson from "../package.json"
import {
  parseAppArguments,
  parseLoginArguments,
  parseLogoutArguments,
  parseRunArguments,
  runLoginCommand,
  runLogoutCommand,
  UsageError,
} from "../src/cli.ts"
import { effectiveHistoryEnabled, effectiveSessionPolicy } from "../src/core/app-options.ts"
import { defaultConfig } from "../src/core/config.ts"
import { formatDoctorReport } from "../src/doctor.ts"
import { credentialsFilePath, resolveApiKey } from "../src/engines/codesplash/auth.ts"
import { APP_VERSION } from "../src/version.ts"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))

const cleanups: string[] = []

afterAll(async () => {
  for (const path of cleanups) await rm(path, { recursive: true, force: true })
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(dir)
  return dir
}

class Sink {
  text = ""

  write(chunk: string): boolean {
    this.text += chunk
    return true
  }
}

describe("parseAppArguments", () => {
  test("parses the project path and defaults", () => {
    expect(parseAppArguments([])).toEqual({
      path: undefined,
      options: { noHistory: false, fullAccess: false },
    })
    expect(parseAppArguments(["/tmp/project"])).toEqual({
      path: "/tmp/project",
      options: { noHistory: false, fullAccess: false },
    })
  })

  test("parses history, sandbox, and full-access flags in any order", () => {
    expect(parseAppArguments(["--no-history", "/tmp/project", "--sandbox", "read-only"])).toEqual({
      path: "/tmp/project",
      options: { noHistory: true, fullAccess: false, sandboxOverride: "read-only" },
    })
    expect(parseAppArguments(["--sandbox=workspace-write", "--full-access"])).toEqual({
      path: undefined,
      options: { noHistory: false, fullAccess: true, sandboxOverride: "workspace-write" },
    })
  })

  test("rejects invalid sandbox values, danger mode via --sandbox, and unknown flags", () => {
    expect(() => parseAppArguments(["--sandbox", "yolo"])).toThrow(
      "--sandbox expects read-only or workspace-write",
    )
    expect(() => parseAppArguments(["--sandbox"])).toThrow("got nothing")
    expect(() => parseAppArguments(["--sandbox", "danger-full-access"])).toThrow(
      "Use --full-access to run without a sandbox",
    )
    expect(() => parseAppArguments(["--frobnicate"])).toThrow("Unknown option --frobnicate")
    expect(() => parseAppArguments(["a", "b"])).toThrow("Expected at most one project path")
  })
})

describe("version and doctor", () => {
  test("APP_VERSION stays in sync with package.json", () => {
    expect(APP_VERSION).toBe(packageJson.version)
  })

  test("--version prints the version and exits cleanly", async () => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", "--version"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(exitCode).toBe(0)
    expect(output.trim()).toBe(APP_VERSION)
  })

  test("--doctor reports diagnostics and always exits 0", async () => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", "--doctor"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(exitCode).toBe(0)
    expect(output).toContain(`CodeSplash Agent ${APP_VERSION}`)
    expect(output).toContain("codex")
    expect(output).toContain("claude")
    expect(output).toContain("codesplash")
    expect(output).toContain("config")
    expect(output).toContain("data")
  }, 30000)

  test("formats missing and unsupported engines as findings, not failures", () => {
    const report = formatDoctorReport({
      version: "9.9.9",
      runtime: "bun 1.3.14",
      platform: "darwin arm64",
      configPath: "/tmp/config.toml",
      configPresent: false,
      dataDirectory: "/tmp/data",
      git: "available",
      codex: { available: true, authenticated: true, compatible: false, version: "0.150.0" },
      claude: { available: false, detail: "Not installed" },
      codesplash: {
        available: false,
        authenticated: false,
        version: "9.9.9",
        detail: "No API keys found — set ANTHROPIC_API_KEY or OPENAI_API_KEY",
      },
    })
    expect(report).toContain("CodeSplash Agent 9.9.9")
    expect(report).toContain("unsupported version")
    expect(report).toContain("○ Not installed")
    expect(report).toContain("codesplash ○ No API keys found — set ANTHROPIC_API_KEY or OPENAI_API_KEY")
    expect(report).toContain("defaults; not created yet")
  })

  test("reports a keyed codesplash engine like the other engines", () => {
    const report = formatDoctorReport({
      version: "9.9.9",
      runtime: "bun 1.3.14",
      platform: "darwin arm64",
      configPath: "/tmp/config.toml",
      configPresent: true,
      dataDirectory: "/tmp/data",
      git: "available",
      codex: { available: true, authenticated: true, version: "0.150.0" },
      claude: { available: true, authenticated: true, version: "2.0.0" },
      codesplash: {
        available: true,
        authenticated: true,
        version: "9.9.9",
        detail: "Anthropic API key · OpenAI API key",
      },
    })
    expect(report).toContain("codesplash ● v9.9.9 · Anthropic API key · OpenAI API key")
  })
})

describe("effective options", () => {
  test("flags override config with flag > config > default precedence", () => {
    const config = structuredClone(defaultConfig)
    config.codex.sandbox = "read-only"
    config.history.enabled = true

    expect(effectiveSessionPolicy(config, { noHistory: false, fullAccess: false })).toEqual({
      sandbox: "read-only",
      approvalPolicy: "on-request",
    })
    expect(
      effectiveSessionPolicy(config, {
        noHistory: false,
        fullAccess: false,
        sandboxOverride: "workspace-write",
      }),
    ).toEqual({ sandbox: "workspace-write", approvalPolicy: "on-request" })
    expect(
      effectiveSessionPolicy(config, {
        noHistory: false,
        fullAccess: true,
        sandboxOverride: "workspace-write",
      }).sandbox,
    ).toBe("danger-full-access")

    expect(effectiveHistoryEnabled(config, { noHistory: false, fullAccess: false })).toBe(true)
    expect(effectiveHistoryEnabled(config, { noHistory: true, fullAccess: false })).toBe(false)
    config.history.enabled = false
    expect(effectiveHistoryEnabled(config, { noHistory: false, fullAccess: false })).toBe(false)
  })
})

describe("parseLoginArguments", () => {
  test("parses the provider and both --api-key forms", () => {
    expect(parseLoginArguments(["anthropic"])).toEqual({ provider: "anthropic", apiKey: undefined })
    expect(parseLoginArguments(["openai", "--api-key", "k-123"])).toEqual({
      provider: "openai",
      apiKey: "k-123",
    })
    expect(parseLoginArguments(["--api-key=k-456", "anthropic"])).toEqual({
      provider: "anthropic",
      apiKey: "k-456",
    })
  })

  test("usage errors: missing provider, extra positionals, bad flags", () => {
    expect(() => parseLoginArguments([])).toThrow(UsageError)
    expect(() => parseLoginArguments([])).toThrow("login expects a provider")
    expect(() => parseLoginArguments(["anthropic", "openai"])).toThrow("login expects exactly one provider")
    expect(() => parseLoginArguments(["anthropic", "--api-key"])).toThrow("--api-key expects a value")
    expect(() => parseLoginArguments(["anthropic", "--frob"])).toThrow("Unknown option --frob for login")
  })

  test("never echoes an unknown provider argument — it could be a pasted key", () => {
    const pastedKey = "sk-super-secret-value"
    try {
      parseLoginArguments([pastedKey])
      throw new Error("expected a UsageError")
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError)
      expect((error as Error).message).not.toContain(pastedKey)
    }
  })
})

describe("parseLogoutArguments", () => {
  test("parses the provider and rejects bad forms", () => {
    expect(parseLogoutArguments(["openai"])).toEqual({ provider: "openai" })
    expect(() => parseLogoutArguments([])).toThrow("logout expects a provider")
    expect(() => parseLogoutArguments(["anthropic", "openai"])).toThrow("logout expects exactly one provider")
    expect(() => parseLogoutArguments(["--force"])).toThrow("Unknown option --force for logout")
    expect(() => parseLogoutArguments(["gemini"])).toThrow("Unknown provider for logout")
  })
})

describe("parseRunArguments", () => {
  const notADirectory = () => false
  const aDirectory = () => true

  test("parses every flag in both space and equals forms", () => {
    expect(
      parseRunArguments(
        [
          "-p",
          "fix it",
          "--model",
          "claude-sonnet-5:high",
          "--output-format",
          "json",
          "--auto",
          "--max-turns",
          "3",
          "--sandbox",
          "read-only",
          "--no-history",
        ],
        notADirectory,
      ),
    ).toEqual({
      path: undefined,
      prompt: "fix it",
      model: "claude-sonnet-5:high",
      outputFormat: "json",
      auto: true,
      maxTurns: 3,
      sandboxOverride: "read-only",
      noHistory: true,
    })
    expect(
      parseRunArguments(
        [
          "--prompt=fix it",
          "--model=gpt-5.1",
          "--output-format=stream-json",
          "--max-turns=7",
          "--sandbox=workspace-write",
        ],
        notADirectory,
      ),
    ).toEqual({
      path: undefined,
      prompt: "fix it",
      model: "gpt-5.1",
      outputFormat: "stream-json",
      auto: false,
      maxTurns: 7,
      sandboxOverride: "workspace-write",
      noHistory: false,
    })
  })

  test("defaults: text output, no auto, no overrides", () => {
    expect(parseRunArguments(["-p", "hello"], notADirectory)).toEqual({
      path: undefined,
      prompt: "hello",
      model: undefined,
      outputFormat: "text",
      auto: false,
      maxTurns: undefined,
      sandboxOverride: undefined,
      noHistory: false,
    })
  })

  test("with --prompt the single positional is the project path", () => {
    const parsed = parseRunArguments(["/tmp/project", "--prompt", "do it"], notADirectory)
    expect(parsed.path).toBe("/tmp/project")
    expect(parsed.prompt).toBe("do it")
    expect(() => parseRunArguments(["a", "b", "-p", "x"], notADirectory)).toThrow(
      "Expected at most one project path with --prompt",
    )
  })

  test("without --prompt the positionals form the prompt", () => {
    expect(parseRunArguments(["fix", "the", "tests"], notADirectory).prompt).toBe("fix the tests")
    expect(parseRunArguments(["fix", "the", "tests"], notADirectory).path).toBeUndefined()
  })

  test("without --prompt a leading directory positional is the path, the rest the prompt", () => {
    const parsed = parseRunArguments(["/tmp/project", "fix the tests"], aDirectory)
    expect(parsed.path).toBe("/tmp/project")
    expect(parsed.prompt).toBe("fix the tests")
    const bare = parseRunArguments(["/tmp/project"], aDirectory)
    expect(bare.path).toBe("/tmp/project")
    expect(bare.prompt).toBeUndefined()
  })

  test("rejects --full-access, danger sandbox, and invalid values as usage errors", () => {
    expect(() => parseRunArguments(["--full-access", "-p", "x"], notADirectory)).toThrow(UsageError)
    expect(() => parseRunArguments(["--full-access", "-p", "x"], notADirectory)).toThrow(
      "interactive sessions only",
    )
    expect(() => parseRunArguments(["--sandbox", "danger-full-access"], notADirectory)).toThrow(
      "interactive sessions only",
    )
    expect(() => parseRunArguments(["--sandbox", "yolo"], notADirectory)).toThrow(
      "--sandbox expects read-only or workspace-write, got yolo",
    )
    expect(() => parseRunArguments(["--output-format", "yaml"], notADirectory)).toThrow(
      "--output-format expects text, json, or stream-json, got yaml",
    )
    expect(() => parseRunArguments(["--output-format"], notADirectory)).toThrow("got nothing")
    expect(() => parseRunArguments(["--max-turns", "zero"], notADirectory)).toThrow(
      "--max-turns expects a positive integer, got zero",
    )
    expect(() => parseRunArguments(["--max-turns", "0"], notADirectory)).toThrow(UsageError)
    expect(() => parseRunArguments(["--max-turns", "2.5"], notADirectory)).toThrow(UsageError)
    expect(() => parseRunArguments(["--prompt"], notADirectory)).toThrow("--prompt expects the prompt text")
    expect(() => parseRunArguments(["--model"], notADirectory)).toThrow("--model expects a model id")
    expect(() => parseRunArguments(["--frobnicate"], notADirectory)).toThrow(
      "Unknown option --frobnicate for run",
    )
  })
})

describe("login and logout round-trip", () => {
  test("login stores the key in a temp config dir and logout removes it", async () => {
    const env: NodeJS.ProcessEnv = { CODESPLASH_AGENT_CONFIG_DIR: await makeTempDir("codesplash-cli-auth-") }
    const stdout = new Sink()
    const stderr = new Sink()

    expect(await runLoginCommand(["anthropic", "--api-key", "round-trip-key"], { env, stdout, stderr })).toBe(
      0,
    )
    expect(stdout.text).toBe(`Saved anthropic API key to ${credentialsFilePath(env)}\n`)
    expect(stdout.text).not.toContain("round-trip-key")
    expect(resolveApiKey("anthropic", env)).toEqual({ key: "round-trip-key", source: "stored" })
    expect(await readFile(credentialsFilePath(env), "utf8")).toContain("round-trip-key")

    stdout.text = ""
    expect(await runLogoutCommand(["anthropic"], { env, stdout, stderr })).toBe(0)
    expect(stdout.text).toBe("Removed stored anthropic API key\n")
    expect(resolveApiKey("anthropic", env)).toBeUndefined()

    stdout.text = ""
    expect(await runLogoutCommand(["anthropic"], { env, stdout, stderr })).toBe(0)
    expect(stdout.text).toBe("No stored anthropic API key\n")
  })

  test("login without --api-key reads the key from piped stdin (first line)", async () => {
    const env: NodeJS.ProcessEnv = { CODESPLASH_AGENT_CONFIG_DIR: await makeTempDir("codesplash-cli-auth-") }
    const stdout = new Sink()
    const code = await runLoginCommand(["openai"], {
      env,
      stdout,
      stderr: new Sink(),
      stdinIsTty: false,
      readStdinText: async () => "piped-key\nsecond line ignored\n",
    })
    expect(code).toBe(0)
    expect(resolveApiKey("openai", env)).toEqual({ key: "piped-key", source: "stored" })
  })

  test("login on a tty uses the hidden secret reader", async () => {
    const env: NodeJS.ProcessEnv = { CODESPLASH_AGENT_CONFIG_DIR: await makeTempDir("codesplash-cli-auth-") }
    const prompts: string[] = []
    const code = await runLoginCommand(["openai"], {
      env,
      stdout: new Sink(),
      stderr: new Sink(),
      stdinIsTty: true,
      readSecret: async (prompt) => {
        prompts.push(prompt)
        return "tty-key"
      },
    })
    expect(code).toBe(0)
    expect(prompts).toEqual(["Enter openai API key (input is hidden): "])
    expect(resolveApiKey("openai", env)).toEqual({ key: "tty-key", source: "stored" })
  })

  test("an empty piped key is a usage error and stores nothing", async () => {
    const env: NodeJS.ProcessEnv = { CODESPLASH_AGENT_CONFIG_DIR: await makeTempDir("codesplash-cli-auth-") }
    await expect(
      runLoginCommand(["anthropic"], {
        env,
        stdout: new Sink(),
        stderr: new Sink(),
        stdinIsTty: false,
        readStdinText: async () => "\n",
      }),
    ).rejects.toThrow(UsageError)
    expect(resolveApiKey("anthropic", env)).toBeUndefined()
  })
})

describe("subcommand usage errors exit 2", () => {
  async function spawnCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CODESPLASH_AGENT_CONFIG_DIR: await makeTempDir("codesplash-cli-spawn-config-"),
        CODESPLASH_AGENT_DATA_DIR: await makeTempDir("codesplash-cli-spawn-data-"),
      },
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { exitCode, stdout, stderr }
  }

  test("run with no prompt anywhere prints a usage error and exits 2", async () => {
    const result = await spawnCli(["run"])
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("codesplash: run needs a prompt")
  }, 30000)

  test("login without a provider exits 2 and --help lists the subcommands", async () => {
    const login = await spawnCli(["login"])
    expect(login.exitCode).toBe(2)
    expect(login.stderr).toContain("codesplash: login expects a provider")

    const help = await spawnCli(["--help"])
    expect(help.exitCode).toBe(0)
    for (const needle of ["login", "logout", "run", "--output-format", "--auto", "--max-turns"]) {
      expect(help.stdout).toContain(needle)
    }
  }, 30000)
})
