/**
 * `codesplash completions <shell>`: prints a static shell-completion script for the harness CLI.
 * The scripts are generated from the shared word lists below so every shell stays in sync with
 * the command surface; there is no dynamic discovery and no I/O beyond stdout.
 */
import type { HeadlessSink } from "../engines/codesplash/runner.ts"
import { UsageError } from "./usage-error.ts"

export type CompletionShell = "bash" | "zsh" | "fish" | "powershell"

export const COMPLETION_SHELLS: readonly CompletionShell[] = ["bash", "zsh", "fish", "powershell"]

/* ------------------------------- shared command surface ------------------------------- */

const SUBCOMMANDS = [
  "login",
  "logout",
  "run",
  "review",
  "stats",
  "completions",
  "debug",
  "sandbox",
  "secrets",
] as const

const ROOT_FLAGS = [
  "--help",
  "--version",
  "--doctor",
  "--no-history",
  "--sandbox",
  "--full-access",
  "--permission-mode",
  "--allow",
  "--ask",
  "--deny",
  "--bypass-approvals",
  "--config",
  "--fixture",
  "--codex-smoke",
  "--codex-live-smoke",
  "--claude-handoff-smoke",
] as const

const RUN_FLAGS = [
  "--prompt",
  "--model",
  "--output-format",
  "--auto",
  "--max-turns",
  "--sandbox",
  "--no-history",
  "--resume",
  "--continue",
  "--effort",
  "--permission-mode",
  "--allow",
  "--ask",
  "--deny",
  "--trust",
  "--config",
] as const

const REVIEW_FLAGS = [
  "--uncommitted",
  "--base",
  "--commit",
  "--model",
  "--output-format",
  "--auto",
  "--permission-mode",
  "--allow",
  "--ask",
  "--deny",
  "--trust",
  "--config",
] as const

const STATS_FLAGS = ["--days", "--json"] as const
const DEBUG_FLAGS = ["--model", "--sandbox", "--config"] as const
const SANDBOX_FLAGS = [
  "--read-only",
  "--read-root",
  "--write-root",
  "--allow-host",
  "--no-history",
  "--",
] as const
const SECRET_ACTIONS = ["set", "list", "delete"] as const

const SANDBOX_VALUES = ["read-only", "workspace-write"] as const
const PERMISSION_MODE_VALUES = ["plan", "default", "accept-edits"] as const
const OUTPUT_FORMAT_VALUES = ["text", "json", "stream-json"] as const
const EFFORT_VALUES = ["low", "medium", "high"] as const
const PROVIDER_VALUES = ["anthropic", "openai"] as const
const DEBUG_TOPICS = ["prompt"] as const

const words = (list: readonly string[]): string => list.join(" ")

/* -------------------------------------- parsing -------------------------------------- */

export function parseCompletionsArguments(args: string[]): { shell: CompletionShell } {
  let shell: CompletionShell | undefined

  for (const argument of args) {
    if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option ${argument} for completions`)
    }
    if (shell !== undefined) throw new UsageError("completions expects exactly one shell")
    if (!(COMPLETION_SHELLS as readonly string[]).includes(argument)) {
      throw new UsageError(
        `Unknown shell "${argument}" for completions; expected bash, zsh, fish, or powershell`,
      )
    }
    shell = argument as CompletionShell
  }

  if (shell === undefined) {
    throw new UsageError("completions expects a shell: codesplash completions <bash|zsh|fish|powershell>")
  }
  return { shell }
}

/** Test seams; every field defaults to the real process surface. */
export type CompletionsCommandOverrides = {
  stdout?: HeadlessSink
}

export async function runCompletionsCommand(
  args: string[],
  overrides: CompletionsCommandOverrides = {},
): Promise<number> {
  const { shell } = parseCompletionsArguments(args)
  const stdout = overrides.stdout ?? process.stdout
  stdout.write(completionScript(shell))
  return 0
}

/* -------------------------------------- scripts -------------------------------------- */

export function completionScript(shell: CompletionShell): string {
  if (shell === "bash") return bashScript()
  if (shell === "zsh") return zshScript()
  if (shell === "fish") return fishScript()
  return powershellScript()
}

function bashScript(): string {
  return `# bash completion for the codesplash harness
# Install: codesplash completions bash > /etc/bash_completion.d/codesplash
#     or: eval "$(codesplash completions bash)"
_codesplash_completions() {
  local cur prev sub
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  sub="\${COMP_WORDS[1]}"

  case "$prev" in
    --sandbox) COMPREPLY=($(compgen -W "${words(SANDBOX_VALUES)}" -- "$cur")); return ;;
    --output-format) COMPREPLY=($(compgen -W "${words(OUTPUT_FORMAT_VALUES)}" -- "$cur")); return ;;
    --effort) COMPREPLY=($(compgen -W "${words(EFFORT_VALUES)}" -- "$cur")); return ;;
    --permission-mode) COMPREPLY=($(compgen -W "${words(PERMISSION_MODE_VALUES)}" -- "$cur")); return ;;
    login|logout) COMPREPLY=($(compgen -W "${words(PROVIDER_VALUES)}" -- "$cur")); return ;;
    completions) COMPREPLY=($(compgen -W "${words(COMPLETION_SHELLS)}" -- "$cur")); return ;;
    debug) COMPREPLY=($(compgen -W "${words(DEBUG_TOPICS)}" -- "$cur")); return ;;
    --model|--prompt|-p|--max-turns|--base|--commit|--resume|--days|--config|-c|--api-key|--allow|--ask|--deny) return ;;
  esac

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "${words(SUBCOMMANDS)} ${words(ROOT_FLAGS)}" -- "$cur"))
    return
  fi

  case "$sub" in
    run) COMPREPLY=($(compgen -W "${words(RUN_FLAGS)} -p" -- "$cur")) ;;
    review) COMPREPLY=($(compgen -W "${words(REVIEW_FLAGS)}" -- "$cur")) ;;
    stats) COMPREPLY=($(compgen -W "${words(STATS_FLAGS)}" -- "$cur")) ;;
    debug) COMPREPLY=($(compgen -W "${words(DEBUG_FLAGS)}" -- "$cur")) ;;
    sandbox) COMPREPLY=($(compgen -W "${words(SANDBOX_FLAGS)}" -- "$cur")) ;;
    secrets) COMPREPLY=($(compgen -W "${words(SECRET_ACTIONS)}" -- "$cur")) ;;
    login) COMPREPLY=($(compgen -W "--api-key" -- "$cur")) ;;
    *) COMPREPLY=($(compgen -W "${words(ROOT_FLAGS)}" -- "$cur")) ;;
  esac
}
complete -F _codesplash_completions codesplash
`
}

function zshScript(): string {
  return `#compdef codesplash
# zsh completion for the codesplash harness
# Install: codesplash completions zsh > "\${fpath[1]}/_codesplash" (then restart compinit)
_codesplash() {
  local prev="\${words[CURRENT-1]}" sub="\${words[2]}"

  case "$prev" in
    --sandbox) compadd ${words(SANDBOX_VALUES)}; return ;;
    --output-format) compadd ${words(OUTPUT_FORMAT_VALUES)}; return ;;
    --effort) compadd ${words(EFFORT_VALUES)}; return ;;
    --permission-mode) compadd ${words(PERMISSION_MODE_VALUES)}; return ;;
    login|logout) compadd ${words(PROVIDER_VALUES)}; return ;;
    completions) compadd ${words(COMPLETION_SHELLS)}; return ;;
    debug) compadd ${words(DEBUG_TOPICS)}; return ;;
    --model|--prompt|-p|--max-turns|--base|--commit|--resume|--days|--config|-c|--api-key|--allow|--ask|--deny) return ;;
  esac

  if (( CURRENT == 2 )); then
    compadd ${words(SUBCOMMANDS)}
    compadd -- ${words(ROOT_FLAGS)}
    return
  fi

  case "$sub" in
    run) compadd -- ${words(RUN_FLAGS)} -p ;;
    review) compadd -- ${words(REVIEW_FLAGS)} ;;
    stats) compadd -- ${words(STATS_FLAGS)} ;;
    debug) compadd -- ${words(DEBUG_FLAGS)} ;;
    sandbox) compadd -- ${words(SANDBOX_FLAGS)} ;;
    secrets) compadd ${words(SECRET_ACTIONS)} ;;
    login) compadd -- --api-key ;;
    *) compadd -- ${words(ROOT_FLAGS)} ;;
  esac
}
_codesplash "$@"
`
}

function fishScript(): string {
  const lines = [
    "# fish completion for the codesplash harness",
    "# Install: codesplash completions fish > ~/.config/fish/completions/codesplash.fish",
    "complete -c codesplash -f",
    `complete -c codesplash -n __fish_use_subcommand -a "${words(SUBCOMMANDS)}"`,
    `complete -c codesplash -n "__fish_seen_subcommand_from login logout" -a "${words(PROVIDER_VALUES)}"`,
    `complete -c codesplash -n "__fish_seen_subcommand_from login" -l api-key -x`,
    `complete -c codesplash -n "__fish_seen_subcommand_from completions" -a "${words(COMPLETION_SHELLS)}"`,
    `complete -c codesplash -n "__fish_seen_subcommand_from debug" -a "${words(DEBUG_TOPICS)}"`,
    `complete -c codesplash -n "__fish_seen_subcommand_from secrets" -a "${words(SECRET_ACTIONS)}"`,
    `complete -c codesplash -n "__fish_seen_subcommand_from sandbox" -l read-only`,
    `complete -c codesplash -n "__fish_seen_subcommand_from sandbox" -l read-root -r`,
    `complete -c codesplash -n "__fish_seen_subcommand_from sandbox" -l write-root -r`,
    `complete -c codesplash -n "__fish_seen_subcommand_from sandbox" -l allow-host -x`,
    `complete -c codesplash -n "__fish_seen_subcommand_from sandbox" -l no-history`,
    `complete -c codesplash -l sandbox -x -a "${words(SANDBOX_VALUES)}"`,
    `complete -c codesplash -l permission-mode -x -a "${words(PERMISSION_MODE_VALUES)}"`,
    `complete -c codesplash -l allow -x`,
    `complete -c codesplash -l ask -x`,
    `complete -c codesplash -l deny -x`,
    `complete -c codesplash -s c -l config -x`,
    `complete -c codesplash -n "__fish_seen_subcommand_from run review" -l trust`,
    `complete -c codesplash -n "__fish_seen_subcommand_from run review" -l output-format -x -a "${words(OUTPUT_FORMAT_VALUES)}"`,
    `complete -c codesplash -n "__fish_seen_subcommand_from run review debug" -l model -x`,
    `complete -c codesplash -n "__fish_seen_subcommand_from run review" -l auto`,
    `complete -c codesplash -n "__fish_seen_subcommand_from run" -s p -l prompt -x`,
    `complete -c codesplash -n "__fish_seen_subcommand_from run" -l max-turns -x`,
    `complete -c codesplash -n "__fish_seen_subcommand_from run" -l effort -x -a "${words(EFFORT_VALUES)}"`,
    `complete -c codesplash -n "__fish_seen_subcommand_from run" -l resume -x`,
    `complete -c codesplash -n "__fish_seen_subcommand_from run" -l continue`,
    `complete -c codesplash -n "__fish_seen_subcommand_from run" -l no-history`,
    `complete -c codesplash -n "__fish_seen_subcommand_from review" -l uncommitted`,
    `complete -c codesplash -n "__fish_seen_subcommand_from review" -l base -x`,
    `complete -c codesplash -n "__fish_seen_subcommand_from review" -l commit -x`,
    `complete -c codesplash -n "__fish_seen_subcommand_from stats" -l days -x`,
    `complete -c codesplash -n "__fish_seen_subcommand_from stats" -l json`,
    `complete -c codesplash -n __fish_use_subcommand -l help`,
    `complete -c codesplash -n __fish_use_subcommand -l version`,
    `complete -c codesplash -n __fish_use_subcommand -l doctor`,
    `complete -c codesplash -n __fish_use_subcommand -l no-history`,
    `complete -c codesplash -n __fish_use_subcommand -l full-access`,
    `complete -c codesplash -n __fish_use_subcommand -l bypass-approvals`,
    `complete -c codesplash -n __fish_use_subcommand -l fixture`,
    `complete -c codesplash -n __fish_use_subcommand -l codex-smoke`,
    `complete -c codesplash -n __fish_use_subcommand -l codex-live-smoke`,
    `complete -c codesplash -n __fish_use_subcommand -l claude-handoff-smoke`,
  ]
  return `${lines.join("\n")}\n`
}

function powershellScript(): string {
  return `# PowerShell completion for the codesplash harness
# Install: codesplash completions powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName codesplash -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $words = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
    $prior = @($words | Where-Object { $_ -ne $wordToComplete })
    $prev = if ($prior.Count -ge 1) { $prior[-1] } else { '' }
    $sub = if ($prior.Count -ge 2) { $prior[1] } else { '' }

    $candidates = switch ($prev) {
        '--sandbox' { @(${quotedList(SANDBOX_VALUES)}) }
        '--output-format' { @(${quotedList(OUTPUT_FORMAT_VALUES)}) }
        '--effort' { @(${quotedList(EFFORT_VALUES)}) }
        '--permission-mode' { @(${quotedList(PERMISSION_MODE_VALUES)}) }
        'login' { @(${quotedList(PROVIDER_VALUES)}) }
        'logout' { @(${quotedList(PROVIDER_VALUES)}) }
        'completions' { @(${quotedList(COMPLETION_SHELLS)}) }
        'debug' { @(${quotedList(DEBUG_TOPICS)}) }
        default {
            switch ($sub) {
                'run' { @(${quotedList(RUN_FLAGS)}, '-p') }
                'review' { @(${quotedList(REVIEW_FLAGS)}) }
                'stats' { @(${quotedList(STATS_FLAGS)}) }
                'debug' { @(${quotedList(DEBUG_FLAGS)}) }
                'sandbox' { @(${quotedList(SANDBOX_FLAGS)}) }
                'secrets' { @(${quotedList(SECRET_ACTIONS)}) }
                'login' { @('--api-key') }
                default { @(${quotedList(SUBCOMMANDS)}, ${quotedList(ROOT_FLAGS)}) }
            }
        }
    }

    $candidates |
        Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`
}

function quotedList(list: readonly string[]): string {
  return list.map((entry) => `'${entry}'`).join(", ")
}
