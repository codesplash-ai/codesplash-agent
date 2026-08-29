import { describe, expect, test } from "bun:test"
import {
  COMPLETION_SHELLS,
  type CompletionShell,
  completionScript,
  parseCompletionsArguments,
  runCompletionsCommand,
} from "../../src/commands/completions.ts"
import { UsageError } from "../../src/commands/usage-error.ts"

class Sink {
  text = ""

  write(chunk: string): boolean {
    this.text += chunk
    return true
  }
}

const SUBCOMMANDS = ["login", "logout", "run", "review", "stats", "completions", "debug"]
const SANDBOX_VALUES = ["read-only", "workspace-write"]
const OUTPUT_FORMATS = ["text", "json", "stream-json"]
const EFFORTS = ["low", "medium", "high"]
const PROVIDERS = ["anthropic", "openai"]
const RUN_FLAGS = [
  "--prompt",
  "--model",
  "--output-format",
  "--auto",
  "--max-turns",
  "--resume",
  "--continue",
  "--effort",
]
const REVIEW_FLAGS = ["--uncommitted", "--base", "--commit"]

describe("parseCompletionsArguments", () => {
  test("accepts each supported shell", () => {
    for (const shell of COMPLETION_SHELLS) {
      expect(parseCompletionsArguments([shell])).toEqual({ shell })
    }
  })

  test("missing shell is a usage error", () => {
    expect(() => parseCompletionsArguments([])).toThrow(UsageError)
    expect(() => parseCompletionsArguments([])).toThrow(/bash\|zsh\|fish\|powershell/)
  })

  test("unknown shell is a usage error naming the expected shells", () => {
    expect(() => parseCompletionsArguments(["tcsh"])).toThrow(UsageError)
    expect(() => parseCompletionsArguments(["tcsh"])).toThrow(/bash, zsh, fish, or powershell/)
  })

  test("extra shells and flags are usage errors", () => {
    expect(() => parseCompletionsArguments(["bash", "zsh"])).toThrow(UsageError)
    expect(() => parseCompletionsArguments(["--bash"])).toThrow(UsageError)
  })
})

/** Fish spells long flags as `-l name`; every other shell contains the literal flag. */
function expectCovered(script: string, shell: CompletionShell, word: string): void {
  if (shell === "fish" && word.startsWith("--")) {
    expect(script).toContain(`-l ${word.slice(2)}`)
  } else {
    expect(script).toContain(word)
  }
}

describe("completion scripts", () => {
  test.each([...COMPLETION_SHELLS] as CompletionShell[])("%s covers the command surface", (shell) => {
    const script = completionScript(shell)
    for (const word of [
      ...SUBCOMMANDS,
      ...SANDBOX_VALUES,
      ...OUTPUT_FORMATS,
      ...EFFORTS,
      ...PROVIDERS,
      ...RUN_FLAGS,
      ...REVIEW_FLAGS,
      "--days",
      "--json",
      "--sandbox",
      "--no-history",
      "--full-access",
      "--doctor",
      "--version",
      "prompt",
    ]) {
      expectCovered(script, shell, word)
    }
    // Shell completion for the completions subcommand itself lists all four shells.
    for (const name of COMPLETION_SHELLS) expect(script).toContain(name)
  })

  test("each shell gets a distinct registration mechanism", () => {
    expect(completionScript("bash")).toContain("complete -F _codesplash_completions codesplash")
    expect(completionScript("zsh")).toContain("#compdef codesplash")
    expect(completionScript("fish")).toContain("complete -c codesplash")
    expect(completionScript("powershell")).toContain("Register-ArgumentCompleter")
  })
})

describe("runCompletionsCommand", () => {
  test("prints the script to stdout and exits 0", async () => {
    const stdout = new Sink()
    const exitCode = await runCompletionsCommand(["fish"], { stdout })
    expect(exitCode).toBe(0)
    expect(stdout.text).toBe(completionScript("fish"))
  })

  test("propagates usage errors for unknown shells", async () => {
    const stdout = new Sink()
    await expect(runCompletionsCommand(["ksh"], { stdout })).rejects.toThrow(UsageError)
    expect(stdout.text).toBe("")
  })
})
