/**
 * Pure shell-command analysis for the permission layer: a hand-rolled POSIX-ish tokenizer,
 * wrapper peeling, the always-ask dangerous floor, the built-in read-only command table, and
 * persistable allow-rule derivation. Platform builtins only — no engine imports — so the
 * permission engine and the loop can consume this module and it can be tested in isolation.
 *
 * Honest layering note: until the OS sandbox lands (M3 tranche 2) this is policy-level analysis
 * feeding rules and approvals, not kernel-level enforcement. Anything the tokenizer cannot fully
 * explain is reported as unanalyzable (undefined) so callers fall back to asking, never guessing.
 */

export type ShellSegment = { argv: string[]; pipedFromPrevious: boolean }

/* ---------------------------------- tokenizer ---------------------------------- */

/**
 * Splits a command line into pipeline/list segments of argv words.
 *
 * undefined = unanalyzable (substitution, backticks, subshell, heredoc, process subst,
 * redirection into a file descriptor trick, unbalanced quotes).
 *
 * Single/double quotes and backslash escapes are resolved; segments split on `&&`, `||`, `;`,
 * `|` (and bash's `|&`), `&`, and newlines, with `|` setting pipedFromPrevious on the following
 * segment. Plain redirections (`>`, `>>`, `<`, `2>&1`, `&>`) are tokenized and kept as argv
 * words — they matter for the dangerous floor and the read-only table — but do not make a
 * command unanalyzable. `#` at a word boundary starts a comment, as in a real shell. Variable
 * references (`$VAR`, `${VAR}`) stay as literal words: rules match the written command, and
 * anything that could rewrite it (`$(`, backticks, `<(`, `>(`) is unanalyzable instead.
 */
export function splitCommandSegments(command: string): ShellSegment[] | undefined {
  const segments: ShellSegment[] = []
  let argv: string[] = []
  let word = ""
  let wordStarted = false
  let currentPiped = false
  let i = 0

  const pushWord = (): void => {
    if (!wordStarted) return
    argv.push(word)
    word = ""
    wordStarted = false
  }
  /** Ends the current segment (skipping empty ones) and records how the next one is joined. */
  const endSegment = (nextPiped: boolean): void => {
    pushWord()
    if (argv.length > 0) segments.push({ argv, pipedFromPrevious: currentPiped })
    argv = []
    currentPiped = nextPiped
  }

  while (i < command.length) {
    const c = command.charAt(i)
    const next = command.charAt(i + 1)

    if (c === "'") {
      const close = command.indexOf("'", i + 1)
      if (close === -1) return undefined // unbalanced quote
      word += command.slice(i + 1, close)
      wordStarted = true
      i = close + 1
      continue
    }

    if (c === '"') {
      i += 1
      let closed = false
      while (i < command.length) {
        const d = command.charAt(i)
        if (d === '"') {
          closed = true
          i += 1
          break
        }
        // Substitution still happens inside double quotes; both forms defeat analysis.
        if (d === "`") return undefined
        if (d === "$" && command.charAt(i + 1) === "(") return undefined
        if (d === "\\") {
          const e = command.charAt(i + 1)
          if (e === "") return undefined // dangling escape at end of input
          if (e === "\n") {
            i += 2 // line continuation
            continue
          }
          if (e === "$" || e === "`" || e === '"' || e === "\\") {
            word += e
            i += 2
            continue
          }
          word += d // before any other character the backslash itself is literal, as in bash
          i += 1
          continue
        }
        word += d
        i += 1
      }
      if (!closed) return undefined
      wordStarted = true // an empty "" is still a word
      continue
    }

    if (c === "\\") {
      if (next === "") return undefined // dangling escape
      if (next === "\n") {
        i += 2 // line continuation
        continue
      }
      word += next
      wordStarted = true
      i += 2
      continue
    }

    if (c === "`") return undefined
    // Any live parenthesis: subshell, and the tail of `$(`, `<(`, `>(` command/process subst.
    if (c === "(" || c === ")") return undefined

    if (c === "#" && !wordStarted) {
      const newline = command.indexOf("\n", i)
      if (newline === -1) break // comment runs to end of input
      i = newline // the newline branch ends the segment
      continue
    }

    if (c === " " || c === "\t" || c === "\r") {
      pushWord()
      i += 1
      continue
    }
    if (c === "\n") {
      // A newline directly after `|` continues the pipeline in a real shell; ending the segment
      // here would drop the pipe flag and let a multi-line `curl … |\n sh` evade the floor.
      if (argv.length === 0 && !wordStarted && currentPiped) {
        i += 1
        continue
      }
      endSegment(false)
      i += 1
      continue
    }

    if (c === "&") {
      if (next === "&") {
        endSegment(false)
        i += 2
        continue
      }
      if (next === ">") {
        // bash `&>` / `&>>`: both streams into a file; an ordinary redirection word.
        pushWord()
        let op = "&>"
        i += 2
        if (command.charAt(i) === ">") {
          op = "&>>"
          i += 1
        }
        argv.push(op)
        continue
      }
      endSegment(false) // background / async list separator
      i += 1
      continue
    }

    if (c === "|") {
      if (next === "|") {
        endSegment(false)
        i += 2
        continue
      }
      if (next === "&") {
        endSegment(true) // bash `|&` pipes stderr too; still a pipe
        i += 2
        continue
      }
      endSegment(true)
      i += 1
      continue
    }

    if (c === ";") {
      endSegment(false)
      i += 1
      continue
    }

    if (c === "<" || c === ">") {
      if (c === "<" && next === "<") return undefined // heredoc / herestring
      if (c === "<" && next === ">") return undefined // `<>` read-write fd trick
      // A word of nothing but digits directly before the operator is its fd number (2>&1).
      let op = ""
      if (wordStarted && /^\d+$/.test(word)) {
        op = word
        word = ""
        wordStarted = false
      } else {
        pushWord()
      }
      op += c
      i += 1
      if (c === ">" && command.charAt(i) === ">") {
        op += ">"
        i += 1
      } else if (c === ">" && command.charAt(i) === "|") {
        op += "|"
        i += 1
      } else if (command.charAt(i) === "&") {
        // Fd duplication (`2>&1`, `<&3`, `>&-`); with no digits the target is a filename word.
        op += "&"
        i += 1
        while (/\d/.test(command.charAt(i))) {
          op += command.charAt(i)
          i += 1
        }
        if (command.charAt(i) === "-") {
          op += "-"
          i += 1
        }
      }
      argv.push(op)
      continue
    }

    word += c
    wordStarted = true
    i += 1
  }

  endSegment(false)
  return segments
}

/* -------------------------------- canonicalization -------------------------------- */

/** Transparent wrappers whose trailing words are the command that actually runs. */
const WRAPPER_COMMANDS = new Set(["env", "nohup", "time", "nice", "stdbuf", "timeout", "command", "exec"])

/** Environment variables that can hijack what a command resolves to or how the shell parses. */
const POISON_ENV_NAMES = new Set(["PATH", "BASH_ENV", "ENV", "IFS", "SHELL"])
const POISON_ENV_PREFIXES = ["LD_", "DYLD_"]

const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*\+?=/

/** Variable name when the word is a leading VAR=val (or VAR+=val) assignment. */
function assignmentName(word: string): string | undefined {
  if (!ASSIGNMENT_PATTERN.test(word)) return undefined
  const name = word.slice(0, word.indexOf("="))
  return name.endsWith("+") ? name.slice(0, -1) : name
}

function isPoisonEnvName(name: string): boolean {
  return POISON_ENV_NAMES.has(name) || POISON_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
}

function commandBasename(word: string): string {
  const slash = word.lastIndexOf("/")
  return slash === -1 ? word : word.slice(slash + 1)
}

/**
 * Index of the wrapped command's first word after the wrapper's own flags, or undefined when a
 * flag defeats analysis (strict mode only; loose mode always yields an index).
 */
function consumeWrapperFlags(wrapper: string, words: string[], loose: boolean): number | undefined {
  let i = 1
  switch (wrapper) {
    case "env": {
      while (i < words.length) {
        const w = words[i] ?? ""
        if (w === "-" || w === "-i" || w === "--ignore-environment" || w === "-0" || w === "--null") {
          i += 1
        } else if (w === "-u" || w === "--unset") {
          i += 2
        } else if (w.startsWith("--unset=")) {
          i += 1
        } else if (w === "--") {
          i += 1
          break
        } else if (w.startsWith("-")) {
          // `-S` re-splits its argument with env's own rules and `-C` moves the cwd; unknown
          // flags may consume a value. Refuse to guess what actually runs.
          if (!loose) return undefined
          i += w === "-S" || w === "--split-string" || w === "-C" || w === "--chdir" ? 2 : 1
        } else {
          break
        }
      }
      return i
    }
    case "nohup":
      return i
    case "time": {
      while (i < words.length) {
        const w = words[i] ?? ""
        if (!w.startsWith("-")) break
        if (w === "-o" || w === "--output" || w.startsWith("--output=")) {
          if (!loose) return undefined // writes a timing file; not transparent
          i += w === "-o" || w === "--output" ? 2 : 1
        } else if (w === "-f" || w === "--format") {
          i += 2
        } else {
          i += 1 // -p, -a, -v, ...
        }
      }
      return i
    }
    case "nice": {
      while (i < words.length) {
        const w = words[i] ?? ""
        if (!w.startsWith("-")) break
        if (w === "-n" || w === "--adjustment") i += 2
        else i += 1 // --adjustment=N, legacy -10
      }
      return i
    }
    case "stdbuf": {
      while (i < words.length) {
        const w = words[i] ?? ""
        if (!w.startsWith("-")) break
        if (w === "-i" || w === "-o" || w === "-e") i += 2
        else i += 1 // attached forms like -oL, --output=L
      }
      return i
    }
    case "timeout": {
      let sawDuration = false
      while (i < words.length) {
        const w = words[i] ?? ""
        if (w === "-s" || w === "--signal" || w === "-k" || w === "--kill-after") {
          i += 2
        } else if (w.startsWith("-")) {
          i += 1 // --signal=X, --foreground, --preserve-status, -v
        } else if (!sawDuration) {
          sawDuration = true
          i += 1 // the duration operand
        } else {
          break
        }
      }
      return i
    }
    case "command": {
      while (i < words.length && (words[i] ?? "").startsWith("-")) i += 1 // -p, -v, -V, --
      return i
    }
    case "exec": {
      while (i < words.length) {
        const w = words[i] ?? ""
        if (w === "-a") i += 2
        else if (w.startsWith("-"))
          i += 1 // -c, -l
        else break
      }
      return i
    }
    default:
      return i
  }
}

/**
 * Shared canonicalization core. Strict mode (the public API) bails on poison assignments and
 * opaque wrapper flags; loose mode peels through everything and is used only by the dangerous
 * floor, which must see through hijack attempts rather than be evaded by them.
 */
function canonicalizeWords(argv: readonly string[], loose: boolean): string[] | undefined {
  let words = [...argv]
  while (true) {
    // Leading VAR=val assignments only adjust the child environment — drop them, unless the
    // variable can change what actually executes (the canonical argv would then be a lie).
    while (words.length > 0) {
      const name = assignmentName(words[0] ?? "")
      if (name === undefined) break
      if (!loose && isPoisonEnvName(name)) return undefined
      words.shift()
    }
    const head = words[0]
    if (head === undefined) return words
    const wrapper = commandBasename(head)
    if (!WRAPPER_COMMANDS.has(wrapper)) {
      // `bash -c '<code>'` hides the real command inside a string operand: the outer argv must
      // never satisfy a pattern rule or derive a grant, so strict analysis refuses it. The
      // dangerous floor (loose) instead recurses into the payload — see dangerousCommandReason.
      if (!loose && isInterpreterCommandInvocation(words)) return undefined
      return words
    }
    const start = consumeWrapperFlags(wrapper, words, loose)
    if (start === undefined) return undefined
    // A bare wrapper (plain `env`, `env -i`) has nothing to peel to; it IS the command.
    if (start >= words.length) return words
    words = words.slice(start)
  }
}

/**
 * Peels wrappers (env/nohup/time/nice/stdbuf/timeout/command/exec, leading VAR=val assignments);
 * returns undefined when an assignment poisons analysis (PATH, LD_*, DYLD_*, BASH_ENV, ENV,
 * IFS, SHELL).
 */
export function canonicalizeSegment(segment: ShellSegment): string[] | undefined {
  return canonicalizeWords(segment.argv, false)
}

/* -------------------------------- pattern matching -------------------------------- */

/** True when every canonical word matches; a final "*" pattern word matches zero or more remaining words. */
export function matchesCommandPattern(canonicalArgv: string[], pattern: string): boolean {
  const words = pattern
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
  if (words.length === 0) return false
  for (let i = 0; i < words.length; i++) {
    const patternWord = words[i] ?? ""
    if (patternWord === "*" && i === words.length - 1) return true
    if (i >= canonicalArgv.length) return false
    if (canonicalArgv[i] !== patternWord) return false // "*" is literal anywhere but last
  }
  return canonicalArgv.length === words.length
}

/* --------------------------------- dangerous floor --------------------------------- */

const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "fish"])
const DOWNLOADERS = new Set(["curl", "wget"])
const POWER_COMMANDS = new Set(["shutdown", "reboot", "halt", "poweroff"])

/** Letters of a combined short-flag word (`-rf` → "rf"), or undefined for anything else. */
function shortFlagLetters(word: string): string | undefined {
  return /^-[A-Za-z]+$/.test(word) ? word.slice(1) : undefined
}

/**
 * True for a shell interpreter invoked with `-c` (or fish's `--command`): the command that
 * actually runs lives inside an opaque string operand, so word-level analysis of the outer argv
 * is a lie. Strict canonicalization treats these as unanalyzable (rules and grants must never
 * vouch for them); the dangerous floor recurses into the payload instead.
 */
function isInterpreterCommandInvocation(words: readonly string[]): boolean {
  if (!SHELL_INTERPRETERS.has(commandBasename(words[0] ?? ""))) return false
  for (let i = 1; i < words.length; i++) {
    const w = words[i] ?? ""
    if (w === "--" || !w.startsWith("-")) break // operands begin; -c must precede them
    if (w === "--command" || w.startsWith("--command=")) return true
    if (shortFlagLetters(w)?.includes("c") === true) return true
  }
  return false
}

/** The `-c` command-string operand of an interpreter invocation, or undefined. */
function interpreterCommandPayload(words: readonly string[]): string | undefined {
  if (!isInterpreterCommandInvocation(words)) return undefined
  for (let i = 1; i < words.length; i++) {
    const w = words[i] ?? ""
    if (w === "--") return words[i + 1]
    if (w.startsWith("--command=")) return w.slice("--command=".length)
    if (!w.startsWith("-")) return w
  }
  return undefined
}

/** Git global flags that consume the following word before the subcommand appears. */
const GIT_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--exec-path",
])

/**
 * Git subcommand and its arguments after skipping the global flags (`git -C dir push …`). The
 * dangerous floor must look THROUGH global flags — the opposite of the read-only table, which
 * conservatively refuses to model them — or `git -C . push --force` would walk past the floor.
 */
function gitSubcommandArgs(canonical: string[]): { subcommand: string | undefined; args: string[] } {
  let i = 1
  while (i < canonical.length) {
    const w = canonical[i] ?? ""
    if (!w.startsWith("-")) break
    i += GIT_VALUE_FLAGS.has(w) ? 2 : 1
  }
  return { subcommand: canonical[i], args: canonical.slice(i + 1) }
}

function dangerousSegmentReason(canonical: string[]): string | undefined {
  const argv0 = commandBasename(canonical[0] ?? "")
  const rest = canonical.slice(1)
  if (argv0 === "sudo" || argv0 === "doas") {
    return `\`${argv0}\` runs a command with elevated privileges`
  }
  if (argv0 === "rm") {
    let recursive = false
    let force = false
    for (const w of rest) {
      if (w === "--recursive") recursive = true
      else if (w === "--force") force = true
      else {
        const letters = shortFlagLetters(w)
        if (letters !== undefined) {
          if (letters.includes("r") || letters.includes("R")) recursive = true
          if (letters.includes("f")) force = true
        }
      }
    }
    if (recursive && force) return "`rm` with recursive and force flags deletes trees without prompting"
  }
  if (argv0 === "dd" && rest.some((w) => w.startsWith("of=/dev/"))) {
    return "`dd` writing straight to a device node"
  }
  if (argv0.startsWith("mkfs")) {
    return `\`${argv0}\` formats a filesystem`
  }
  if (POWER_COMMANDS.has(argv0)) {
    return `\`${argv0}\` powers the machine down or restarts it`
  }
  if ((argv0 === "kill" || argv0 === "pkill") && rest.includes("-1")) {
    return `\`${argv0} -1\` signals every process on the system`
  }
  if (argv0 === "chmod") {
    const recursive = rest.some((w) => {
      if (w === "--recursive") return true
      return shortFlagLetters(w)?.includes("R") === true // chmod recursion is capital-R only
    })
    if (recursive && (rest.includes("777") || rest.includes("0777"))) {
      return "`chmod -R 777` makes an entire tree world-writable"
    }
  }
  if (argv0 === "git") {
    const { subcommand, args } = gitSubcommandArgs(canonical)
    if (subcommand === "push") {
      const forced = args.some(
        (w) =>
          w === "-f" || w === "--force" || w === "--force-with-lease" || w.startsWith("--force-with-lease="),
      )
      if (forced || args.some((w) => w.startsWith("+"))) {
        return "`git push` forcing a remote ref can overwrite published history"
      }
    }
  }
  return undefined
}

/**
 * Reason string when the command hits the always-ask dangerous floor.
 *
 * Segments are canonicalized loosely (hijack assignments and opaque wrapper flags peeled rather
 * than bailed on): the floor must see through `PATH=/tmp rm -rf x`, not be evaded by it.
 * Unanalyzable commands never reach this function and are NOT dangerous by themselves.
 */
export function dangerousCommandReason(segments: ShellSegment[]): string | undefined {
  const canonicals = segments.map((segment) => canonicalizeWords(segment.argv, true) ?? [...segment.argv])
  for (let i = 0; i < segments.length; i++) {
    const canonical = canonicals[i] ?? []
    const reason = dangerousSegmentReason(canonical)
    if (reason !== undefined) return reason
    // Interpreter `-c` strings re-enter the floor: `bash -c 'rm -rf /'` is exactly as dangerous
    // as the payload it carries. An unanalyzable payload is not flagged here — strict analysis
    // already reports the whole invocation unanalyzable, and that tier always asks.
    const payload = interpreterCommandPayload(canonical)
    if (payload !== undefined) {
      const inner = splitCommandSegments(payload)
      if (inner !== undefined) {
        const innerReason = dangerousCommandReason(inner)
        if (innerReason !== undefined) return innerReason
      }
    }
    // Pipe-to-shell: a shell fed by a pipe whose chain contains a downloader earlier on.
    if (!(segments[i]?.pipedFromPrevious ?? false)) continue
    const argv0 = commandBasename(canonical[0] ?? "")
    if (!SHELL_INTERPRETERS.has(argv0)) continue
    for (let j = i - 1; j >= 0; j--) {
      const earlierArgv0 = commandBasename((canonicals[j] ?? [])[0] ?? "")
      if (DOWNLOADERS.has(earlierArgv0)) {
        return `piping a \`${earlierArgv0}\` download into \`${argv0}\` executes unreviewed code`
      }
      if (!(segments[j]?.pipedFromPrevious ?? false)) break // reached the head of this chain
    }
  }
  return undefined
}

/* -------------------------------- read-only command table -------------------------------- */

const READ_ONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "which",
  "stat",
  "file",
  "du",
  "df",
  "ps",
  "env",
  "printenv",
  "date",
  "whoami",
  "uname",
  "readlink",
  "realpath",
  "dirname",
  "basename",
  "grep",
  "rg",
  "fd",
  "tree",
])

/** find primaries that delete, run commands, or write files. */
const FIND_MUTATING_PRIMARIES = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
])

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "shortlog",
  "describe",
  "rev-parse",
  "remote",
  "branch",
  "blame",
  "ls-files",
  "ls-remote",
])

/** List-style short flags are the only extras allowed on `git remote` / `git branch`. */
const GIT_LIST_FLAG_PATTERN = /^-[var]+$/

/**
 * `>`-family words that create or truncate a file (`>`, `>>`, `2>`, `>|`, `&>`, and a bare `>&`
 * whose target filename follows). Pure fd duplication (`2>&1`, `>&2`, `>&-`) stays read-only.
 */
function isWriteRedirectionWord(word: string): boolean {
  return /^\d*>{1,2}$/.test(word) || /^\d*>\|$/.test(word) || /^&>{1,2}$/.test(word) || /^\d*>&$/.test(word)
}

function isReadOnlySegment(canonical: string[]): boolean {
  const argv0 = canonical[0]
  if (argv0 === undefined) return false
  if (canonical.some(isWriteRedirectionWord)) return false
  const rest = canonical.slice(1)
  if (argv0 === "find") return !rest.some((w) => FIND_MUTATING_PRIMARIES.has(w))
  if (argv0 === "git") {
    // The subcommand must be argv[1]: global flags like `-C dir` are not modeled, so a command
    // using them simply does not qualify as read-only (conservative, never permissive).
    const subcommand = canonical[1]
    if (subcommand === undefined || !GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return false
    // `--output[=<file>]` / `--output-directory` make git log/diff/show write files (with
    // attacker-controllable content in a cloned repo); never read-only.
    if (
      canonical.some(
        (w) =>
          w === "--output" ||
          w.startsWith("--output=") ||
          w === "--output-directory" ||
          w.startsWith("--output-directory="),
      )
    ) {
      return false
    }
    if (subcommand === "remote" || subcommand === "branch") {
      return canonical.slice(2).every((w) => w === "--list" || GIT_LIST_FLAG_PATTERN.test(w))
    }
    return true
  }
  if (!READ_ONLY_COMMANDS.has(argv0)) return false
  if (argv0 === "rg" && rest.some((w) => w === "--pre" || w.startsWith("--pre="))) {
    return false // --pre runs an arbitrary preprocessor per file
  }
  if (argv0 === "fd") {
    const runsCommands = rest.some((w) => {
      if (w === "--exec" || w === "--exec-batch") return true
      const letters = shortFlagLetters(w)
      return letters !== undefined && (letters.includes("x") || letters.includes("X"))
    })
    if (runsCommands) return false
  }
  if (argv0 === "tree") {
    // `tree -o <file>` writes the listing to a file; not read-only.
    const writesFile = rest.some((w) => shortFlagLetters(w)?.includes("o") === true)
    if (writesFile) return false
  }
  return true
}

/** True when every segment canonicalizes and matches the built-in read-only command table. */
export function isReadOnlyCommandLine(segments: ShellSegment[]): boolean {
  if (segments.length === 0) return false
  return segments.every((segment) => {
    const canonical = canonicalizeWords(segment.argv, false)
    if (canonical === undefined || canonical.length === 0) return false
    return isReadOnlySegment(canonical)
  })
}

/* ------------------------------- persistable patterns ------------------------------- */

/** Words safe to embed in a stored rule: no glob, quote, expansion, or redirection characters. */
const SAFE_PATTERN_WORD_PATTERN = /^[A-Za-z0-9_@%+=:,.~/-]+$/

/**
 * Persistable allow-rule pattern for a command, or undefined when none is safe to derive.
 *
 * Every segment must canonicalize and share the same derived prefix — argv0 plus argv1 when it
 * is not flag-like (`-`-prefixed) — which becomes `<prefix> *`. Dangerous-floor commands and
 * prefixes containing shell metacharacters never derive a pattern.
 */
export function persistablePattern(segments: ShellSegment[]): string | undefined {
  if (segments.length === 0) return undefined
  if (dangerousCommandReason(segments) !== undefined) return undefined
  let shared: string | undefined
  for (const segment of segments) {
    const canonical = canonicalizeWords(segment.argv, false)
    if (canonical === undefined) return undefined
    const argv0 = canonical[0]
    if (argv0 === undefined) return undefined
    // A shell-interpreter prefix (`bash *`, `sh *`) would allow-list arbitrary code fed to the
    // interpreter across future sessions; never derive one.
    if (SHELL_INTERPRETERS.has(commandBasename(argv0))) return undefined
    const argv1 = canonical[1]
    const words = argv1 !== undefined && !argv1.startsWith("-") ? [argv0, argv1] : [argv0]
    if (!words.every((word) => SAFE_PATTERN_WORD_PATTERN.test(word))) return undefined
    const prefix = words.join(" ")
    if (shared === undefined) shared = prefix
    else if (shared !== prefix) return undefined
  }
  return shared === undefined ? undefined : `${shared} *`
}
