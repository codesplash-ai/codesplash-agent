/**
 * Permission engine for the CodeSplash harness: merges rule tiers (cli > project > user >
 * grants > built-in), evaluates the binding eight-tier decision pipeline for every tool call,
 * and persists remembered "always allow" grants.
 *
 * Honest layering note: until M3 tranche 2 lands the OS sandbox, `bash` enforcement here is
 * policy-level (shell analysis + approvals), not kernel-level. The write-path floors apply to
 * the file tools, not to what a shell command does once approved.
 */
import { realpathSync } from "node:fs"
import { chmod, mkdir, readFile, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  configDirectory,
  dataDirectory,
  isPermissionMode,
  isValidPermissionRule,
  type PermissionRuleOverrides,
  stringifyToml,
} from "../../core/index.ts"
import {
  canonicalizeSegment,
  dangerousCommandReason,
  isReadOnlyCommandLine,
  matchesCommandPattern,
  persistablePattern,
  type ShellSegment,
  splitCommandSegments,
} from "./command-analysis.ts"
import {
  ASK_USER_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRuntime,
  type PermissionTargets,
} from "./contracts.ts"

export type PermissionRuleSource = "cli" | "project" | "user" | "grants" | "builtin"

export type ParsedPermissionRule = {
  tool: string
  pattern?: string
  action: "allow" | "ask" | "deny"
  source: PermissionRuleSource
  raw: string
}

export type PermissionRuntimeOptions = {
  cwd: string
  mode: PermissionMode
  workspaceTrusted: boolean
  /** The [permissions] tables from config.toml — the user tier. */
  configRules: { allow: readonly string[]; ask: readonly string[]; deny: readonly string[] }
  /** Repeatable --allow/--ask/--deny flags — the cli tier, highest rule precedence. */
  overrides?: PermissionRuleOverrides
  /** Remembered-grants file; absent → "always allow" is never offered and never persisted. */
  grantsPath?: string
  onWarning?: (message: string) => void
  onModeChange?: (mode: PermissionMode) => void
}

/**
 * The concrete runtime createPermissionRuntime returns: the contracts interface plus the two
 * extras the loop and TUI consume — rule introspection for the /permissions overlay and
 * persistable-rule derivation for the default-path acceptAlways choice.
 */
export interface CodesplashPermissionRuntime extends PermissionRuntime {
  describeRules(): ParsedPermissionRule[]
  /** Grant rule an acceptAlways would persist; undefined when none is safe (or no grants file). */
  derivePersistableRule(toolName: string, targets: PermissionTargets | undefined): string | undefined
}

/** Relative path of the project-tier rule file, loaded only when the workspace is trusted. */
export const PROJECT_PERMISSIONS_RELATIVE_PATH = join(".codesplash", "permissions.toml")

/** Relative path of the plan file — the one .codesplash/ entry the write floor exempts. */
export const PLAN_FILE_RELATIVE_PATH = join(".codesplash", "plan.md")

/** Tools whose rules take a pattern; every other tool accepts only the bare `tool` form. */
const FILE_TOOL_NAMES = new Set(["read_file", "write_file", "edit_file", "apply_patch"])
const PATTERN_TOOL_NAMES = new Set([...FILE_TOOL_NAMES, "bash", "web_fetch"])

/** Every tool name rules may reference; anything else warns once and the rule is ignored. */
const KNOWN_TOOL_NAMES = new Set([
  "request_permissions",
  ...PATTERN_TOOL_NAMES,
  "glob",
  "grep",
  "todo_write",
  "web_search",
  ASK_USER_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
])

/** Tools whose mode defaults treat targets as edits (accept-edits auto-allow inside cwd). */
const EDIT_TOOL_NAMES = new Set(["write_file", "edit_file", "apply_patch"])

/**
 * Built-in sensitive-read deny patterns (read_file and grep content access). An explicit allow
 * rule overrides them — the pipeline checks explicit allow first.
 */
export const SENSITIVE_READ_PATTERNS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/*.pem",
  "**/*.p12",
]
const SENSITIVE_READ_EXEMPT_BASENAMES = new Set([".env.example", ".env.sample", ".env.template"])

const BUILTIN_RULES: readonly ParsedPermissionRule[] = SENSITIVE_READ_PATTERNS.map((pattern) => ({
  tool: "read_file",
  pattern,
  action: "deny",
  source: "builtin",
  raw: `read_file(${pattern})`,
}))

/* --------------------------------- rule parsing --------------------------------- */

type RuleSets = {
  /** Merged deny rules in cli, project, user order (first match names the decision). */
  deny: ParsedPermissionRule[]
  /** Merged ask rules in cli, project, user order. */
  ask: ParsedPermissionRule[]
  /** Merged allow rules in cli, project, user, grants order. */
  allow: ParsedPermissionRule[]
}

type Warn = (message: string, dedupeKey?: string) => void

function splitRuleString(raw: string): { tool: string; pattern?: string } {
  const open = raw.indexOf("(")
  if (open === -1) return { tool: raw }
  return { tool: raw.slice(0, open), pattern: raw.slice(open + 1, -1) }
}

/** Parses one tier's rule strings into `out`, warning about (and dropping) unusable rules. */
function collectRules(
  raws: readonly string[],
  action: ParsedPermissionRule["action"],
  source: PermissionRuleSource,
  out: ParsedPermissionRule[],
  warn: Warn,
): void {
  for (const raw of raws) {
    if (!isValidPermissionRule(raw)) {
      warn(
        `Ignoring ${source} ${action} rule ${JSON.stringify(raw)}: rules are "tool" or "tool(pattern)" (lowercase tool name, non-empty pattern)`,
      )
      continue
    }
    const { tool, pattern } = splitRuleString(raw)
    if (!KNOWN_TOOL_NAMES.has(tool)) {
      // Warn once per unknown tool name, however many rules reference it.
      warn(
        `Ignoring permission rules for unknown tool "${tool}" (e.g. ${source} ${action} rule ${JSON.stringify(raw)})`,
        `unknown-tool:${tool}`,
      )
      continue
    }
    if (pattern !== undefined && !PATTERN_TOOL_NAMES.has(tool)) {
      warn(
        `Ignoring ${source} ${action} rule ${JSON.stringify(raw)}: "${tool}" rules do not take a pattern; use the bare "${tool}" form`,
      )
      continue
    }
    const rule: ParsedPermissionRule = { tool, action, source, raw }
    if (pattern !== undefined) rule.pattern = pattern
    out.push(rule)
  }
}

/** Reads a string array off a parsed TOML table, warning about anything malformed. */
function readRuleArray(table: Record<string, unknown>, key: string, label: string, warn: Warn): string[] {
  const value = table[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    warn(`${label}: "${key}" must be an array of rule strings; ignoring it`)
    return []
  }
  const rules: string[] = []
  for (const entry of value) {
    if (typeof entry === "string") rules.push(entry)
    else warn(`${label}: "${key}" entries must be rule strings; ignoring ${JSON.stringify(entry)}`)
  }
  return rules
}

/**
 * Loads `<cwd>/.codesplash/permissions.toml` — the project tier. Callers gate this on workspace
 * trust; parse errors warn and the file is ignored, never a crash. `mode` is deliberately not
 * read from the project file (a cloned repo must not pick the session's mode).
 */
async function loadProjectTier(
  cwd: string,
  warn: Warn,
): Promise<{ allow: string[]; ask: string[]; deny: string[] }> {
  const empty = { allow: [], ask: [], deny: [] }
  const path = join(cwd, PROJECT_PERMISSIONS_RELATIVE_PATH)

  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return empty
    warn(`Could not read ${path}: ${errorMessage(error)}; ignoring the project permission rules`)
    return empty
  }

  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(source)
  } catch (error) {
    warn(`Could not parse ${path}: ${errorMessage(error)}; ignoring the project permission rules`)
    return empty
  }
  if (!isRecord(parsed)) {
    warn(`${path}: expected a TOML table with allow/ask/deny arrays; ignoring it`)
    return empty
  }
  if (parsed.mode !== undefined) {
    warn(`${path}: "mode" is not read from the project file; set it in config.toml or via --permission-mode`)
  }
  return {
    allow: readRuleArray(parsed, "allow", path, warn),
    ask: readRuleArray(parsed, "ask", path, warn),
    deny: readRuleArray(parsed, "deny", path, warn),
  }
}

/* ------------------------------- grants persistence ------------------------------- */

/**
 * Reads the remembered-grant rules (`allow = [...]` TOML) at `grantsPath`. A missing, corrupt,
 * or malformed file reads as empty; entries that fail the rule grammar are dropped.
 */
export async function readPermissionGrants(grantsPath: string): Promise<string[]> {
  let source: string
  try {
    source = await readFile(grantsPath, "utf8")
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(source)
  } catch {
    return []
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.allow)) return []
  return parsed.allow.filter(
    (entry): entry is string => typeof entry === "string" && isValidPermissionRule(entry),
  )
}

/** Atomic (tmp + rename) 0600-file / 0700-dir write of the grants file. */
async function writeGrantsFile(grantsPath: string, rules: readonly string[]): Promise<void> {
  await mkdir(dirname(grantsPath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${grantsPath}.${process.pid}.tmp`
  await Bun.write(temporaryPath, stringifyToml({ allow: [...rules] }))
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, grantsPath)
}

/** Removes one remembered grant. Missing file or absent rule is a no-op, never an error. */
export async function removePermissionGrant(grantsPath: string, rule: string): Promise<void> {
  const existing = await readPermissionGrants(grantsPath)
  if (!existing.includes(rule)) return
  await writeGrantsFile(
    grantsPath,
    existing.filter((entry) => entry !== rule),
  )
}

/* ------------------------------ path + host matching ------------------------------ */

const globCache = new Map<string, Bun.Glob>()

function globMatch(pattern: string, path: string): boolean {
  let glob = globCache.get(pattern)
  if (glob === undefined) {
    glob = new Bun.Glob(pattern)
    globCache.set(pattern, glob)
  }
  try {
    return glob.match(path)
  } catch {
    return false
  }
}

/** Exact hostname, or `*.suffix` matching the suffix itself and any subdomain of it. */
function hostMatches(pattern: string, host: string): boolean {
  // DNS-wise "evil.com." IS "evil.com"; strip the FQDN trailing dot so it cannot evade a rule.
  const normalizedHost = host.toLowerCase().replace(/\.+$/, "")
  const normalizedPattern = pattern.toLowerCase().replace(/\.+$/, "")
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(2)
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`)
  }
  return normalizedHost === normalizedPattern
}

/**
 * Physical (realpath) resolution that tolerates not-yet-existing tails: the deepest existing
 * ancestor is realpathed and the remaining components are rejoined. This is what keeps a
 * symlink inside the workspace from smuggling a write into .git or the config directory.
 */
function resolvePhysical(path: string): string {
  let current = resolve(path)
  const tail: string[] = []
  while (true) {
    try {
      const real = realpathSync(current)
      return tail.length === 0 ? real : join(real, ...tail.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return tail.length === 0 ? current : join(current, ...tail.reverse())
      tail.push(basename(current))
      current = parent
    }
  }
}

function containedIn(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep)
}

/* ---------------------------- persistable-rule derivation ---------------------------- */

/**
 * Rule an acceptAlways decision would persist for this call, or undefined when none is safe to
 * derive: bash → `bash(<persistablePattern>)`; file tools with a single out-of-workspace
 * target → `<tool>(<parent-dir>/**)` absolute; web_fetch → `web_fetch(<host>)`.
 */
export function derivePersistableRule(
  toolName: string,
  targets: PermissionTargets | undefined,
  cwd: string,
): string | undefined {
  if (toolName === "bash") {
    if (targets?.command === undefined) return undefined
    const segments = splitCommandSegments(targets.command)
    if (segments === undefined) return undefined
    const pattern = persistablePattern(segments)
    return pattern === undefined ? undefined : `bash(${pattern})`
  }
  if (FILE_TOOL_NAMES.has(toolName)) {
    const paths = targets?.paths
    if (paths === undefined || paths.length !== 1 || paths[0] === undefined) return undefined
    const physical = resolvePhysical(paths[0])
    if (containedIn(physical, resolvePhysical(cwd))) return undefined
    const parent = dirname(physical)
    // A grant is only as narrow as its parent directory. For a target directly under `/` the
    // derived rule would be `<tool>(/**)` — an allow-everything grant from one keystroke — so
    // refuse to derive when the parent is the root, a first-level directory, or the home
    // directory itself; the user can still accept the single call, just not persist it.
    if (isOverbroadGrantParent(parent)) return undefined
    return `${toolName}(${parent.endsWith(sep) ? parent : parent + sep}**)`
  }
  if (toolName === "web_fetch" && targets?.urlHost !== undefined) {
    return `web_fetch(${targets.urlHost.toLowerCase().replace(/\.+$/, "")})`
  }
  return undefined
}

/** True when a `<parent>/**` grant would blanket the root, a top-level directory, or `~`. */
function isOverbroadGrantParent(parent: string): boolean {
  const components = parent.split(sep).filter((part) => part !== "")
  if (components.length < 2) return true
  return parent === resolvePhysical(homedir())
}

/**
 * Directory part of a glob pattern's leading non-glob text (`/etc/**` → `/etc`, `src/**` →
 * `src`), or undefined when the pattern has none (`**` and friends).
 */
function patternConstantPrefix(pattern: string): string | undefined {
  const globAt = pattern.search(/[*?[{]/)
  const constant = globAt === -1 ? pattern : pattern.slice(0, globAt)
  const slash = constant.lastIndexOf("/")
  if (slash === 0) return "/"
  if (slash < 0) return undefined
  return constant.slice(0, slash)
}

/* --------------------------------- the runtime --------------------------------- */

/** Per-call shell analysis, computed once per decide() and shared across the tiers. */
type BashAnalysis = {
  segments: ShellSegment[] | undefined
  canonical: Array<string[] | undefined>
  /** True when the command split AND every segment canonicalized. */
  analyzable: boolean
}

function analyzeBash(command: string | undefined): BashAnalysis {
  if (command === undefined) return { segments: undefined, canonical: [], analyzable: false }
  const segments = splitCommandSegments(command)
  if (segments === undefined || segments.length === 0) {
    return { segments: undefined, canonical: [], analyzable: false }
  }
  const canonical = segments.map((segment) => canonicalizeSegment(segment))
  return { segments, canonical, analyzable: canonical.every((argv) => argv !== undefined) }
}

export async function createPermissionRuntime(
  options: PermissionRuntimeOptions,
): Promise<CodesplashPermissionRuntime> {
  const seenWarnings = new Set<string>()
  const warn: Warn = (message, dedupeKey) => {
    const key = dedupeKey ?? message
    if (seenWarnings.has(key)) return
    seenWarnings.add(key)
    options.onWarning?.(message)
  }

  const cwdLexical = resolve(options.cwd)
  const cwdPhysical = resolvePhysical(cwdLexical)

  /** Write-floor roots, physically resolved once. The .git check is component-based instead. */
  const floor = {
    configDir: resolvePhysical(configDirectory()),
    dataDir: resolvePhysical(dataDirectory()),
    sshDir: resolvePhysical(join(homedir(), ".ssh")),
    codesplashDir: join(cwdPhysical, ".codesplash"),
    planFile: join(cwdPhysical, PLAN_FILE_RELATIVE_PATH),
  }

  // Project tier is trust-gated: an untrusted folder's rule file is never even read.
  const projectTier = options.workspaceTrusted
    ? await loadProjectTier(cwdLexical, warn)
    : { allow: [], ask: [], deny: [] }

  let grantRules: string[] = []
  if (options.grantsPath !== undefined) {
    try {
      const source = await readFile(options.grantsPath, "utf8")
      const parsed = Bun.TOML.parse(source)
      if (isRecord(parsed) && Array.isArray(parsed.allow)) {
        grantRules = parsed.allow.filter((entry): entry is string => typeof entry === "string")
      } else {
        warn(`Permission grants at ${options.grantsPath} are malformed; treating them as empty`)
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        warn(
          `Could not read permission grants at ${options.grantsPath}: ${errorMessage(error)}; treating them as empty`,
        )
      }
    }
  }

  const rules: RuleSets = { deny: [], ask: [], allow: [] }
  for (const action of ["deny", "ask", "allow"] as const) {
    collectRules(options.overrides?.[action] ?? [], action, "cli", rules[action], warn)
    collectRules(projectTier[action], action, "project", rules[action], warn)
    collectRules(options.configRules[action], action, "user", rules[action], warn)
  }
  collectRules(grantRules, "allow", "grants", rules.allow, warn)

  let mode: PermissionMode = options.mode

  function workspaceRelative(path: string): string | undefined {
    for (const root of [cwdLexical, cwdPhysical]) {
      const rel = relative(root, path)
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel
    }
    return undefined
  }

  /** Glob rules match BOTH the absolute path and, when inside cwd, the workspace-relative one. */
  function pathRuleMatches(pattern: string, path: string): boolean {
    if (globMatch(pattern, path)) return true
    const rel = workspaceRelative(path)
    return rel !== undefined && globMatch(pattern, rel)
  }

  /**
   * Restrictive (deny/ask/built-in) path matching: the rule fires on the path as written OR on
   * its physical resolution, so a symlink cannot smuggle a protected target past a deny rule.
   */
  function restrictivePathMatches(pattern: string, path: string): boolean {
    if (pathRuleMatches(pattern, path)) return true
    const physical = resolvePhysical(path)
    return physical !== resolve(path) && pathRuleMatches(pattern, physical)
  }

  /**
   * Permissive (allow) path matching vouches for what is PHYSICALLY touched. A lexical-only
   * match is honored just when the target still physically lives under the pattern's own
   * physically resolved constant prefix — so `write_file(/etc/**)` works on macOS where /etc is
   * itself a symlink — never when a symlink inside the allowed subtree points somewhere else
   * (`src/link -> ~` must not turn `write_file(src/**)` into a home-directory write).
   */
  function allowPathMatches(pattern: string, path: string): boolean {
    const physical = resolvePhysical(path)
    if (pathRuleMatches(pattern, physical)) return true
    if (!pathRuleMatches(pattern, path)) return false
    const prefix = patternConstantPrefix(pattern)
    if (prefix === undefined) return false
    const roots = isAbsolute(prefix) ? [prefix] : [join(cwdLexical, prefix), join(cwdPhysical, prefix)]
    return roots.some((root) => containedIn(physical, resolvePhysical(root)))
  }

  /**
   * Disjunctive ("any target") rule matching, used by the deny and ask tiers. Unanalyzable bash
   * commands match only bare `bash` rules — a pattern can never vouch for what it cannot see.
   */
  function ruleMatchesCall(
    rule: ParsedPermissionRule,
    toolName: string,
    targets: PermissionTargets | undefined,
    bash: BashAnalysis | undefined,
  ): boolean {
    if (rule.tool !== toolName) return false
    if (rule.pattern === undefined) return true
    const pattern = rule.pattern
    if (toolName === "bash") {
      if (bash?.segments === undefined) return false
      return bash.canonical.some((argv) => argv !== undefined && matchesCommandPattern(argv, pattern))
    }
    if (FILE_TOOL_NAMES.has(toolName)) {
      return (targets?.paths ?? []).some((path) => restrictivePathMatches(pattern, path))
    }
    if (toolName === "web_fetch") {
      return targets?.urlHost !== undefined && hostMatches(pattern, targets.urlHost)
    }
    return false // Patterned rules on other tools were dropped at parse time.
  }

  function ruleLabel(matched: readonly ParsedPermissionRule[]): string {
    const parts = matched.map((rule) => `"${rule.raw}" (${rule.source})`)
    return `${matched.length === 1 ? "allow rule" : "allow rules"} ${parts.join(", ")}`
  }

  /**
   * Conjunctive allow matching: every bash segment / every target path must be vouched for by
   * at least one allow rule. Returns the reason naming the matched rules, or undefined.
   */
  function allowMatchReason(
    toolName: string,
    targets: PermissionTargets | undefined,
    bash: BashAnalysis | undefined,
  ): string | undefined {
    const candidates = rules.allow.filter((rule) => rule.tool === toolName)
    if (candidates.length === 0) return undefined
    const bare = candidates.find((rule) => rule.pattern === undefined)

    if (toolName === "bash") {
      if (bash === undefined || !bash.analyzable) {
        // Unanalyzable commands never match a pattern rule; only a bare `bash` allow applies.
        return bare === undefined ? undefined : ruleLabel([bare])
      }
      const matched: ParsedPermissionRule[] = []
      for (const argv of bash.canonical as string[][]) {
        const rule = candidates.find(
          (candidate) => candidate.pattern === undefined || matchesCommandPattern(argv, candidate.pattern),
        )
        if (rule === undefined) return undefined
        if (!matched.includes(rule)) matched.push(rule)
      }
      return ruleLabel(matched)
    }

    if (FILE_TOOL_NAMES.has(toolName)) {
      const paths = targets?.paths ?? []
      if (paths.length === 0) return bare === undefined ? undefined : ruleLabel([bare])
      const matched: ParsedPermissionRule[] = []
      for (const path of paths) {
        // Allow rules vouch for the PHYSICAL target: a symlink inside an allowed subtree must
        // not turn a scoped rule into a write (or read) anywhere it points.
        const rule = candidates.find(
          (candidate) => candidate.pattern === undefined || allowPathMatches(candidate.pattern, path),
        )
        if (rule === undefined) return undefined
        if (!matched.includes(rule)) matched.push(rule)
      }
      return ruleLabel(matched)
    }

    if (toolName === "web_fetch") {
      const host = targets?.urlHost
      const rule = candidates.find(
        (candidate) =>
          candidate.pattern === undefined || (host !== undefined && hostMatches(candidate.pattern, host)),
      )
      return rule === undefined ? undefined : ruleLabel([rule])
    }

    return bare === undefined ? undefined : ruleLabel([bare])
  }

  /** Tier-1 write floor for one physically resolved target path. */
  function writeFloorReason(physicalPath: string): string | undefined {
    const suffix = "; no permission mode or rule overrides this"
    if (physicalPath.split(sep).includes(".git")) {
      return `write floor (self-protection): "${physicalPath}" resolves into a .git directory${suffix}`
    }
    if (containedIn(physicalPath, floor.configDir)) {
      return `write floor (self-protection): "${physicalPath}" resolves into the harness config directory${suffix}`
    }
    if (containedIn(physicalPath, floor.dataDir)) {
      return `write floor (self-protection): "${physicalPath}" resolves into the harness data directory${suffix}`
    }
    if (containedIn(physicalPath, floor.sshDir)) {
      return `write floor (self-protection): "${physicalPath}" resolves into ~/.ssh${suffix}`
    }
    if (containedIn(physicalPath, floor.codesplashDir) && physicalPath !== floor.planFile) {
      return `write floor (self-protection): "${physicalPath}" is inside .codesplash/ — only ${PLAN_FILE_RELATIVE_PATH} may be written there${suffix}`
    }
    return undefined
  }

  function sensitiveReadPattern(path: string): string | undefined {
    // Judge the file that is actually read: a symlink named readme.txt pointing at .env is a
    // .env read, and a symlink named .env pointing at .env.example is an exempt one.
    const physical = resolvePhysical(path)
    if (SENSITIVE_READ_EXEMPT_BASENAMES.has(basename(physical))) return undefined
    for (const pattern of SENSITIVE_READ_PATTERNS) {
      if (pathRuleMatches(pattern, physical)) return pattern
    }
    return undefined
  }

  function builtinReadDenyReason(path: string, pattern: string, toolName: string): string {
    // Name the physical target when a symlink was involved: it is what actually matched.
    const physical = resolvePhysical(path)
    const shown = physical === resolve(path) ? `"${path}"` : `"${path}" (resolves to "${physical}")`
    return `built-in read protection: ${shown} matches "${pattern}" (${toolName}); an explicit allow rule like read_file(${pattern}) overrides it`
  }

  function persistable(toolName: string, targets: PermissionTargets | undefined): string | undefined {
    // No grants file → the "always allow" choice must never be offered, so derive nothing.
    if (options.grantsPath === undefined) return undefined
    return derivePersistableRule(toolName, targets, cwdLexical)
  }

  /** Tier-8 mode defaults; reached only when no floor or explicit rule decided the call. */
  function modeDefault(
    toolName: string,
    targets: PermissionTargets | undefined,
    isReadOnly: boolean,
    bash: BashAnalysis | undefined,
  ): PermissionDecision {
    if (mode === "bypass") return { kind: "allow", reason: "bypass mode" }

    if (mode === "accept-edits") {
      if (EDIT_TOOL_NAMES.has(toolName)) {
        const paths = targets?.paths ?? []
        if (paths.length > 0 && paths.every((path) => containedIn(resolvePhysical(path), cwdPhysical))) {
          return { kind: "allow", reason: "accept-edits mode: every target is inside the workspace" }
        }
      }
      return { kind: "default" }
    }

    if (mode === "plan") {
      if (isReadOnly) return { kind: "default" }
      if (toolName === "write_file" || toolName === "edit_file") {
        const paths = targets?.paths ?? []
        if (paths.length > 0 && paths.every((path) => resolvePhysical(path) === floor.planFile)) {
          return { kind: "allow", reason: "plan mode: writing the plan file" }
        }
      }
      if (toolName === "bash") {
        if (bash?.segments !== undefined && isReadOnlyCommandLine(bash.segments)) {
          return { kind: "allow", reason: "plan mode: read-only command" }
        }
        return { kind: "ask", reason: "plan mode" }
      }
      return {
        kind: "deny",
        reason: "Plan mode is read-only — write the plan to .codesplash/plan.md and call exit_plan_mode",
      }
    }

    return { kind: "default" }
  }

  const runtime: CodesplashPermissionRuntime = {
    async reload(): Promise<void> {
      const next = await createPermissionRuntime({ ...options, mode })
      const loaded = describePermissionRules(next).filter((r) => r.source !== "builtin")
      for (const action of ["allow", "ask", "deny"] as const)
        rules[action].splice(0, rules[action].length, ...loaded.filter((r) => r.action === action))
    },
    get mode(): PermissionMode {
      return mode
    },

    setMode(next: PermissionMode): void {
      if (!isPermissionMode(next)) {
        throw new Error(
          `Unknown permission mode ${JSON.stringify(next)}; expected "plan", "default", "accept-edits", or "bypass"`,
        )
      }
      mode = next
      options.onModeChange?.(next)
    },

    /** The binding eight-tier pipeline; see DESIGN-M3.md "Phase 2 — permission-engine". */
    decide(toolName, targets, isReadOnly): PermissionDecision {
      const bash = toolName === "bash" ? analyzeBash(targets?.command) : undefined

      // 1. Write floor — mutating file targets; applies in every mode, bypass included.
      if (!isReadOnly && targets?.paths !== undefined) {
        for (const path of targets.paths) {
          const reason = writeFloorReason(resolvePhysical(path))
          if (reason !== undefined) return { kind: "deny", reason }
        }
      }

      // 2. Explicit deny — merged cli/project/user tiers, first match names the decision.
      const denied = rules.deny.find((rule) => ruleMatchesCall(rule, toolName, targets, bash))
      if (denied !== undefined) {
        return { kind: "deny", reason: `deny rule "${denied.raw}" (${denied.source})` }
      }

      // 3. Dangerous floor (bash only) — always asks; never persistable, grants do not apply.
      if (bash?.segments !== undefined) {
        const reason = dangerousCommandReason(bash.segments)
        if (reason !== undefined) return { kind: "ask", alwaysAsk: true, reason }
      }

      // 4. Explicit ask.
      const asked = rules.ask.find((rule) => ruleMatchesCall(rule, toolName, targets, bash))
      if (asked !== undefined) {
        const decision: PermissionDecision = {
          kind: "ask",
          reason: `ask rule "${asked.raw}" (${asked.source})`,
        }
        const rule = persistable(toolName, targets)
        if (rule !== undefined) decision.persistableRule = rule
        return decision
      }

      // 5. Explicit allow — conjunctive: every segment / every path must match a rule.
      const allowReason = allowMatchReason(toolName, targets, bash)
      if (allowReason !== undefined) return { kind: "allow", reason: allowReason }

      // 6. Built-in sensitive-read deny (read_file; grep goes through isReadDenied).
      if (toolName === "read_file" && targets?.paths !== undefined) {
        for (const path of targets.paths) {
          const pattern = sensitiveReadPattern(path)
          if (pattern !== undefined) {
            return { kind: "deny", reason: builtinReadDenyReason(path, pattern, toolName) }
          }
        }
      }

      // 7. Unanalyzable-bash hardening — deliberately bypasses the tool's sessionKey grant.
      // alwaysAsk: an unanalyzable command can hide any dangerous-floor shape behind `$(:)` or
      // an interpreter -c string, so it gets the floor's own treatment — never auto-approved
      // (headless --auto declines it), never remembered.
      if (toolName === "bash" && mode !== "bypass" && bash !== undefined && !bash.analyzable) {
        return {
          kind: "ask",
          alwaysAsk: true,
          reason:
            "the command could not be analyzed (substitution, subshell, interpreter -c, or environment override); it always requires interactive approval",
        }
      }

      // 8. Mode default.
      return modeDefault(toolName, targets, isReadOnly, bash)
    },

    /** Same precedence as the pipeline for content reads: deny > allow > built-in. */
    isReadDenied(resolvedPath, toolName): string | undefined {
      // A bare `read_file` deny matches every path — same semantics as ruleMatchesCall — and
      // patterned denies match the written path or its physical resolution (symlink-proof).
      const denied = rules.deny.find(
        (rule) =>
          rule.tool === "read_file" &&
          (rule.pattern === undefined || restrictivePathMatches(rule.pattern, resolvedPath)),
      )
      if (denied !== undefined) return `deny rule "${denied.raw}" (${denied.source})`
      const allowed = rules.allow.find(
        (rule) =>
          rule.tool === "read_file" &&
          (rule.pattern === undefined || allowPathMatches(rule.pattern, resolvedPath)),
      )
      if (allowed !== undefined) return undefined
      const pattern = sensitiveReadPattern(resolvedPath)
      if (pattern !== undefined) return builtinReadDenyReason(resolvedPath, pattern, toolName)
      return undefined
    },

    async persistGrant(rule: string): Promise<void> {
      const grantsPath = options.grantsPath
      if (grantsPath === undefined) {
        throw new Error("No permission grants file is configured for this session")
      }
      if (!isValidPermissionRule(rule)) {
        throw new Error(`Cannot persist invalid permission rule ${JSON.stringify(rule)}`)
      }
      const existing = await readPermissionGrants(grantsPath)
      if (!existing.includes(rule)) await writeGrantsFile(grantsPath, [...existing, rule])
      // Take effect immediately in this session (dedup against an already-loaded grant).
      if (!rules.allow.some((entry) => entry.source === "grants" && entry.raw === rule)) {
        collectRules([rule], "allow", "grants", rules.allow, warn)
      }
    },

    describeRules(): ParsedPermissionRule[] {
      return [...rules.deny, ...rules.ask, ...rules.allow, ...BUILTIN_RULES]
    },

    derivePersistableRule(toolName, targets): string | undefined {
      return persistable(toolName, targets)
    },
  }

  return runtime
}

/**
 * Merged parsed rules with sources (built-in tier included) for the /permissions overlay.
 * A runtime from another implementation (e.g. a scripted test double without describeRules)
 * yields an empty list rather than a crash.
 */
export function describePermissionRules(runtime: PermissionRuntime): ParsedPermissionRule[] {
  const candidate = runtime as Partial<CodesplashPermissionRuntime>
  return typeof candidate.describeRules === "function" ? candidate.describeRules() : []
}

/* ----------------------------------- helpers ----------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
