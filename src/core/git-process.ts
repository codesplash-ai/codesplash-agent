import { tmpdir } from "node:os"
import { childEnvironment } from "../engines/codesplash/sandbox/env-policy.ts"

/** Read-only harness Git helpers never invoke repo-controlled diff, pager, hook or monitor code. */
export function safeGitArguments(args: string[]): string[] {
  const command = args[0]
  const rest =
    command === "diff" || command === "show"
      ? [command, "--no-ext-diff", "--no-textconv", ...args.slice(1)]
      : args
  return [
    "--no-pager",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    ...rest,
  ]
}
export function safeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...childEnvironment(tmpdir()),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  }
}
