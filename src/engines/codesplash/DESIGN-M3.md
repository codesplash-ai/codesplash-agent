# CodeSplash engine — M3 tranche 1: permissions core (binding spec)

Extends DESIGN.md, DESIGN-M2.md, and DESIGN-M2B.md. Same house rules: no new dependencies,
contracts-first, tests for every cap and refusal, `.ts` import extensions, the product is a
"harness", format only your own files, run ONLY your own test files
(`bun test tests/...<yours>`), never the full check.

Out of scope for this tranche (explicitly deferred to M3 tranche 2): the first-party OS sandbox
(sandbox-exec / bwrap enforcement), the permission-escalation request tool, sandbox env policy /
profile pinning / `codesplash sandbox -- CMD` / sandbox event logging, the keyring secrets store,
and the guardian LLM classifier. Do not build placeholders for them. This tranche is the pure-TS
policy layer: rules, shell analysis, dangerous floor, remembered grants, workspace trust, plan
mode, bypass mode, and their TUI/CLI surface.

Honest layering note (repeat it in README and code comments where relevant): until tranche 2
lands the OS sandbox, `bash` enforcement is policy-level (analysis + approvals), not
kernel-level. The write-path floors apply to the file tools, not to what a shell command does.

## Phases and module ownership (one owner per file per phase)

| Phase | Task | Files owned |
|---|---|---|
| 1 | foundations | `src/engines/codesplash/contracts.ts`, `src/core/config.ts`, `src/core/engine.ts`, `src/core/app-options.ts`, `src/core/events.ts`, `src/core/reducer.ts`, `src/core/trust.ts` (new), `src/core/index.ts` (exports), matching tests |
| 2 | command-analysis | `src/engines/codesplash/command-analysis.ts` (new), `tests/engines/codesplash/command-analysis.test.ts` |
| 2 | permission-engine | `src/engines/codesplash/permissions.ts` (new), `tests/engines/codesplash/permissions.test.ts` |
| 2 | loop-tools | `src/engines/codesplash/loop.ts`, `src/engines/codesplash/tools/*.ts` (incl. new `tools/plan-mode.ts`, `tools/registry.ts`), `tests/engines/codesplash/loop-permissions.test.ts`, existing tool tests it must update |
| 2 | session-wiring | `src/engines/codesplash/engine.ts`, `src/engines/codesplash/prompt.ts`, `src/engines/codesplash/runner.ts`, `src/core/sessions.ts`, matching tests |
| 2 | tui | `src/tui/codex-session.tsx`, `src/tui/run-codex-session.tsx`, `src/tui/run-welcome.tsx`, `src/tui/trust-gate.tsx` (new), `src/tui/full-access-confirmation.tsx` (only if generalizing it), `tests/tui/*` it owns |
| 3 | cli wiring | `src/cli.ts`, `src/doctor.ts`, `src/commands/review.ts` (flag pass-through only), `README.md`, `CHANGELOG.md`, `src/engines/codesplash/index.ts`, affected CLI tests |
| 4–6 | integrator, reviewers, fixer | as directed |

Phase-2 tasks run in parallel and must not touch each other's files. `permissions.ts` codes
against the `command-analysis.ts` API pinned below; both build in parallel.

## Phase 1 — foundations

### core/config.ts (binding)

- New exported type `PermissionMode = "plan" | "default" | "accept-edits" | "bypass"`.
- `AgentConfig` gains:

```toml
[permissions]
mode = "default"                      # "plan" | "default" | "accept-edits"
allow = ["bash(git status *)"]        # rule strings, default []
ask = []
deny = ["read_file(**/*.secret)"]
```

  Typed as `permissions: { mode: Exclude<PermissionMode,"bypass">; allow: string[]; ask: string[];
  deny: string[] }`, default `{ mode: "default", allow: [], ask: [], deny: [] }`.
- Validation, aggregated in the existing style: `mode = "bypass"` is refused as a persisted
  default (message mirrors the danger-full-access refusal: bypass requires the
  `--bypass-approvals` flag per session). Each rule string must match
  `/^[a-z][a-z0-9_-]*(\(.+\))?$/` (tool name, optional non-empty parenthesized pattern);
  violations name the offending rule. Unknown tool NAMES are not a config error (forward
  compat) — the engine warns at session open.
- `saveConfig` round-trips `[permissions]` (write the table only when any field differs from the
  default, matching the `[codesplash]`/`[providers]` style).

### core/engine.ts (binding)

- `SessionPolicy` gains `permissionMode?: PermissionMode` (absent means "default").
  `defaultSessionPolicy` unchanged otherwise.
- `OpenSessionOptions` gains:
  - `workspaceTrusted?: boolean` — resolved by the caller from the trust store; engines treat
    absent as `true` (back-compat for existing call sites; the TUI and runner always pass the
    real value).
  - `permissionOverrides?: { allow?: readonly string[]; ask?: readonly string[];
    deny?: readonly string[] }` — the CLI rule tier.
  - `permissionGrantsPath?: string` — file where the engine persists/loads remembered grants
    (same caller-placed-file pattern as `nativeTranscriptPath`). Absent → the "always allow"
    choice is never offered.
- `EngineSession` gains optional `setPermissionMode?(mode: PermissionMode): Promise<void>`.

### core/app-options.ts (binding)

`AppOptions` gains: `permissionModeOverride?: PermissionMode`, `bypassApprovals: boolean`
(default false), `allowRules`, `askRules`, `denyRules` (all `readonly string[]`, default `[]`),
and `trustWorkspace: boolean` (default false; the `--trust` flag).
`effectiveSessionPolicy` resolves `permissionMode`: `bypassApprovals` → `"bypass"`, else
`permissionModeOverride ?? config.permissions.mode`.

### core/events.ts + reducer.ts (binding)

- `session.status` payload gains optional `permissionMode?: string`. The reducer stores it on
  `AppViewState` (new optional field `permissionMode`) when present and leaves the previously
  known value untouched when absent (verify the reducer does not clobber `model` either when a
  later status omits it — if it does, fix that for `permissionMode` only, do not change existing
  `model` semantics in this tranche).
- `request.opened` payload gains optional `alwaysAsk?: boolean` — true only for dangerous-floor
  approvals; consumers that auto-answer (headless runner) must decline these even under `--auto`.

### core/trust.ts (new, binding)

```ts
export type TrustDecision = { trusted: boolean; decidedAt: string }
export async function readTrustDecision(workspacePath: string, dataDir?: string): Promise<TrustDecision | undefined>
export async function writeTrustDecision(workspacePath: string, trusted: boolean, dataDir?: string): Promise<void>
```

Store: `<dataDir>/trusted-folders.json`, shape `{ version: 1, folders: { "<realpath>":
{ trusted, decidedAt } } }`. Keys are `fs.realpath` of the workspace (fallback: `resolve`).
Atomic write (`.tmp` + rename), 0600 file / 0700 dir. A corrupt or unreadable store reads as
empty and is rewritten on the next write, never a crash. `decidedAt` is ISO-8601.

### engines/codesplash/contracts.ts (binding)

- Re-export `PermissionMode` from core (or import type where needed; keep contracts
  dependency-light as today — it already imports `SessionPolicy`).
- New: `PermissionTargets = { command?: string; paths?: string[]; urlHost?: string }` — `paths`
  are RESOLVED ABSOLUTE paths.
- `HarnessTool` gains optional
  `permissionTargets?(input: unknown, context: ToolContext): PermissionTargets` (may throw
  `ToolInputError`; the loop then falls through to the default path and lets `run()` surface the
  input error).
- New: `PermissionDecision =`
  `| { kind: "allow"; reason: string }`
  `| { kind: "deny"; reason: string }`
  `| { kind: "ask"; alwaysAsk?: boolean; persistableRule?: string; reason?: string }`
  `| { kind: "default" }` (fall through to the tool's own `permission()` flow, unchanged).
- New interface the loop and tools consume (implemented by permissions.ts):

```ts
export interface PermissionRuntime {
  readonly mode: PermissionMode
  setMode(mode: PermissionMode): void
  decide(toolName: string, targets: PermissionTargets | undefined, isReadOnly: boolean): PermissionDecision
  /** Read-path denial for grep content access; reason string when denied. */
  isReadDenied(resolvedPath: string, toolName: string): string | undefined
  persistGrant(rule: string): Promise<void>
}
```

- `ToolContext` gains `permissions?: PermissionRuntime`.
- New tool-name constants: `ENTER_PLAN_MODE_TOOL_NAME = "enter_plan_mode"`,
  `EXIT_PLAN_MODE_TOOL_NAME = "exit_plan_mode"` (intrinsic, loop-executed like `ask_user`).
- `SystemPromptOptions` gains `permissionMode?: PermissionMode` and
  `workspaceTrusted?: boolean` (default true).

Foundations also exports everything new through `src/core/index.ts` and writes type-level +
behavioral tests for config validation, trust store round-trip/corruption, and
applyConfigOverrides interaction with `[permissions]` (e.g. `-c permissions.mode=plan`).

## Phase 2 — command-analysis (binding API)

`src/engines/codesplash/command-analysis.ts`, pure module, no imports beyond node/bun builtins.

```ts
export type ShellSegment = { argv: string[]; pipedFromPrevious: boolean }
/** undefined = unanalyzable (substitution, backticks, subshell, heredoc, process subst, redirection into a file descriptor trick, unbalanced quotes). */
export function splitCommandSegments(command: string): ShellSegment[] | undefined
/** Peels wrappers (env/nohup/time/nice/stdbuf/timeout/command/exec, leading VAR=val assignments); returns undefined when an assignment poisons analysis (PATH, LD_*, DYLD_*, BASH_ENV, ENV, IFS, SHELL). */
export function canonicalizeSegment(segment: ShellSegment): string[] | undefined
/** True when every canonical word matches; a final "*" pattern word matches zero or more remaining words. */
export function matchesCommandPattern(canonicalArgv: string[], pattern: string): boolean
/** Reason string when the command hits the always-ask dangerous floor. */
export function dangerousCommandReason(segments: ShellSegment[]): string | undefined
/** True when every segment canonicalizes and matches the built-in read-only command table. */
export function isReadOnlyCommandLine(segments: ShellSegment[]): boolean
/** Persistable allow-rule pattern for a command, or undefined when none is safe to derive. */
export function persistablePattern(segments: ShellSegment[]): string | undefined
```

- Tokenizer: hand-rolled POSIX-ish — single/double quotes, backslash escapes, splitting on
  `&&`, `||`, `;`, `|`, `&`, newlines. `|` sets `pipedFromPrevious` on the following segment.
  Anything containing `$(`, backticks, `<(`, `>(`, `(` subshells, heredocs (`<<`), or unbalanced
  quoting returns undefined. Plain redirections (`>`, `>>`, `<`, `2>&1`) are tokenized and kept
  as argv words (they matter for the dangerous floor), but do NOT make a command unanalyzable.
- Dangerous floor (any canonical segment; binding starter set, each with a distinct reason):
  `sudo`/`doas` anything; `rm` with recursive AND force flags (combined short flags count:
  `-rf`, `-fR`, `--recursive --force`); `dd` with an `of=/dev/...` word; `mkfs*`;
  `shutdown`/`reboot`/`halt`/`poweroff`; `kill`/`pkill` targeting `-1`; `chmod -R 777`;
  `git push` with `--force`/`-f`/`--force-with-lease` or a `+`-prefixed refspec;
  pipe-to-shell: a segment whose argv0 is `sh`/`bash`/`zsh`/`fish` with `pipedFromPrevious`
  true and any earlier segment in the same chain having argv0 `curl`/`wget`. Unanalyzable is
  NOT dangerous by itself.
- Read-only command table (binding starter set; extend with tests):
  `ls cat head tail wc pwd which stat file du df ps env printenv date whoami uname readlink
  realpath dirname basename grep rg fd tree`; `find` WITHOUT `-delete`/`-exec`/`-execdir`/`-ok`;
  `git` with first subcommand in `status log diff show shortlog describe rev-parse remote
  branch blame ls-files ls-remote` where `remote`/`branch` carry only list-style flags
  (`-v`, `-a`, `-r`, `--list`, no positional mutation args for branch beyond none).
- `persistablePattern`: every segment must canonicalize; all segments must share the same
  derived prefix, which is argv0 plus argv1-when-not-flag-like (`-`-prefixed) joined, plus a
  trailing ` *`; e.g. `git status --short && git status` → `git status *`; `ls -la` → `ls *`.
  Mixed-prefix compounds → undefined.

Tests: quoting/escapes, pipelines, unanalyzable forms, wrapper peeling incl. hijack env vars,
every dangerous-floor entry positive AND a near-miss negative (e.g. `rm -r` alone is not floor,
`git push` alone is not floor), read-only table positives/negatives, persistable patterns.

## Phase 2 — permission-engine (binding)

`src/engines/codesplash/permissions.ts`. Implements `PermissionRuntime`.

```ts
export type PermissionRuleSource = "cli" | "project" | "user" | "grants" | "builtin"
export type ParsedPermissionRule = { tool: string; pattern?: string; action: "allow"|"ask"|"deny"; source: PermissionRuleSource; raw: string }
export type PermissionRuntimeOptions = {
  cwd: string
  mode: PermissionMode
  workspaceTrusted: boolean
  configRules: { allow: readonly string[]; ask: readonly string[]; deny: readonly string[] }   // user tier
  overrides?: { allow?: readonly string[]; ask?: readonly string[]; deny?: readonly string[] } // cli tier
  grantsPath?: string
  onWarning?: (message: string) => void
  onModeChange?: (mode: PermissionMode) => void
}
export async function createPermissionRuntime(options: PermissionRuntimeOptions): Promise<PermissionRuntime>
export function describePermissionRules(runtime: PermissionRuntime): ParsedPermissionRule[]   // for the TUI overlay
export async function readPermissionGrants(grantsPath: string): Promise<string[]>
export async function removePermissionGrant(grantsPath: string, rule: string): Promise<void>
```

- Rule grammar: `tool` (matches every call of that tool) or `tool(pattern)`. Pattern semantics
  by tool: `bash` → `matchesCommandPattern` against canonical segments; file tools
  (`read_file`, `write_file`, `edit_file`, `apply_patch`) → `Bun.Glob` matched against BOTH the
  workspace-relative path (when inside cwd) and the absolute path; `web_fetch` → hostname,
  exact or `*.suffix`; every other tool → bare form only (a pattern on them warns and the rule
  is ignored). Unknown tool names warn once via `onWarning` and are ignored.
- Project tier: `<cwd>/.codesplash/permissions.toml` with `allow`/`ask`/`deny` string arrays
  (same grammar; `mode` is NOT read from the project file). Loaded ONLY when
  `workspaceTrusted`. Parse errors → `onWarning`, file ignored. Grants tier: `grantsPath` TOML
  `allow = [...]`; corrupt → warning + treated empty. `persistGrant` appends (dedup), atomic
  write 0600 / dir 0700.
- **Decision pipeline (binding order)** — `decide(toolName, targets, isReadOnly)`:
  1. **Write floor** (mutating file targets; applies in EVERY mode and sandbox, bypass and
     danger-full-access included): any target path resolving into a `.git` component, the
     harness config directory, the harness data directory, `~/.ssh`, or `<cwd>/.codesplash/`
     EXCEPT exactly `<cwd>/.codesplash/plan.md` → `deny` naming self-protection. Containment
     checks use realpath-style physical resolution (symlinks must not smuggle a target out).
  2. **Explicit deny** (cli > project > user tiers; first match wins, tiers are one merged set
     — precedence across actions matters, not across tiers): any matching deny rule → `deny`
     naming the rule and its source. For bash: ANY canonical segment matching → deny;
     unanalyzable commands match only bare `bash` rules.
  3. **Dangerous floor** (bash only): `dangerousCommandReason` → `ask` with `alwaysAsk: true`
     (never auto-approved, never persistable, session grants do not apply).
  4. **Explicit ask**: any matching ask rule → `ask` (persistableRule only from
     `persistablePattern`/path/host derivation below).
  5. **Explicit allow** (cli/project/user/grants): bash → EVERY canonical segment must match at
     least one allow rule (conjunctive; unanalyzable never matches a pattern rule); file tools →
     every target path must match; web_fetch → host match → `allow` naming the rule.
  6. **Built-in sensitive-read deny** (`read_file` targets and grep via `isReadDenied`):
     patterns `**/.env`, `**/.env.*`, `**/id_rsa*`, `**/id_ed25519*`, `**/*.pem`, `**/*.p12`,
     with built-in exemptions `.env.example`, `.env.sample`, `.env.template` → `deny` with a
     message that names the pattern and says an explicit allow rule overrides it (an explicit
     allow already won at step 5).
  7. **Unanalyzable-bash hardening**: in plan/default/accept-edits modes an unanalyzable bash
     command → `ask` (no persistableRule; this deliberately bypasses the tool's sessionKey
     grant — a `bash:git` session grant must not auto-approve `` git `evil` ``).
  8. **Mode default**: `bypass` → `allow` ("bypass mode"); `accept-edits` → for
     `write_file`/`edit_file`/`apply_patch` with every target inside cwd → `allow`, else
     `default`; `plan` → mutating tools: plan-file write (`write_file`/`edit_file` targeting
     exactly `<cwd>/.codesplash/plan.md`) → `allow`, bash where `isReadOnlyCommandLine` →
     `allow`, bash otherwise → `ask` (reason "plan mode"), any other mutating tool → `deny`
     ("Plan mode is read-only — write the plan to .codesplash/plan.md and call
     exit_plan_mode"); read-only tools → `default`; `default` mode → `{ kind: "default" }`.
- persistableRule derivation for step 4/ask flows and the loop's default-path acceptAlways:
  bash → `bash(<persistablePattern>)`; file tools with a single out-of-workspace target →
  `<tool>(<parent-dir>/**)` absolute; web_fetch → `web_fetch(<host>)`; else undefined.
- `setMode` validates the mode, records it, and calls `onModeChange` (the session emits the
  event). `describePermissionRules` returns the merged parsed rules with sources, builtin tier
  included, for the overlay.

Tests: every pipeline tier with positive/negative cases, tier precedence collisions (deny vs
allow same rule, allow overriding builtin read-deny, dangerous floor overriding an allow rule
and a session-grant scenario), project tier gated by trust, grants round-trip/dedup/remove,
unknown-tool and bad-pattern warnings, symlinked `.git` floor, plan-file exception, glob
matching relative and absolute.

## Phase 2 — loop-tools (binding)

- `CodesplashLoopOptions` gains `permissions?: PermissionRuntime`; `#toolContext` includes it.
- `#runToolCall`, BEFORE today's `tool.permission()` flow:
  `const targets = tool.permissionTargets?.(call.input, ctx)` (ToolInputError → targets
  undefined, fall through to default so `run()`/parse surfaces the error as today);
  `const decision = permissions?.decide(tool.name, targets, tool.isReadOnly(call.input)) ?? { kind: "default" }`.
  - `deny` → `#failCall` with `Denied by permission rule: <reason>` (no request opened).
  - `allow` → run the tool with no approval.
  - `ask` → open the existing approval request with choices `["accept", "acceptAlways"?,
    "decline", "cancel"]` — `acceptAlways` included only when `persistableRule` is set and
    `alwaysAsk` is not; the `request.opened` payload carries `alwaysAsk` when set. Title/detail
    come from the tool's own `permission()` when it returns kind "approval" (reuse its
    title/detail), else `Run ${tool.name}?` with the provisional label as detail. On
    `acceptAlways`: `await permissions.persistGrant(rule)` (failure → warning event, still run),
    then run. `decline`/`cancel` → same messages as today.
  - `default` → today's flow byte-for-byte (tool.permission(), sessionApprovals, A/S/D/C), with
    ONE addition: when the tool's default flow would ask and a `persistableRule` is derivable
    (loop asks the runtime via a small helper or recomputes decision context), append
    `acceptAlways` to the choices there too, with the same persist semantics.
- `#canRunConcurrently` only batches calls whose decision is `allow`, or `default` AND
  permission kind "none" (as today). `deny`/`ask` stay barriers.
- Intrinsic plan tools (execute in the loop like ask_user; specs registered in
  `tools/plan-mode.ts`, run() never called):
  - `enter_plan_mode` `{}`: not in plan mode → `permissions.setMode("plan")`, result "Plan mode
    is on. Investigate read-only, write the plan to .codesplash/plan.md, then call
    exit_plan_mode."; already in plan mode → isError "Already in plan mode." No approval.
  - `exit_plan_mode` `{ plan?: string }`: not in plan mode → isError. Plan text = `input.plan`
    ?? contents of `<cwd>/.codesplash/plan.md`; neither → isError telling the model to write
    the plan file first. Opens request kind "approval", title "Approve this plan?", detail =
    plan text (cap the detail at 8KB with a truncation note), choices
    `["approve", "keepPlanning", "cancel"]`. `approve` → `setMode` back to the mode the session
    had before entering plan (track it; default "default"), result "The user approved the
    plan. Plan mode is off — proceed with the implementation."; `keepPlanning`/`cancel` →
    non-error result "The user chose to keep planning." Both registered in `builtinTools()`
    after `ask_user`; `permissions` absent (no runtime injected) → both return isError
    "Plan mode is not available in this session."
  - Loop-internal mode changes go through `permissions.setMode`, whose `onModeChange` is wired
    by the session (phase-2 session-wiring) to emit `session.status` with `permissionMode`.
- Tool changes (same owner):
  - `permissionTargets` implementations: bash → `{ command }`; read/write/edit → `{ paths:
    [resolve(cwd, path)] }`; apply_patch → `{ paths }` from its existing patch parse (reuse,
    do not duplicate); web_fetch → `{ urlHost }` parsed from the input URL (bad URL → throw
    ToolInputError); glob/grep/todo/ask_user/web_search → none (bare rules still match via
    decide()).
  - grep: before reading each candidate file's content, skip files where
    `context.permissions?.isReadDenied(path, "grep")` returns a reason; count them and append
    one summary line `([N] file(s) skipped by permission rules)` when any were skipped.
  - write/edit/apply_patch keep their existing sandbox refusals and permission() functions
    unchanged (they are the "default" tier).

Tests (`loop-permissions.test.ts` + tool tests): deny short-circuits with no request, allow
skips approval, ask with acceptAlways persists then runs, alwaysAsk excludes acceptAlways,
dangerous ask overrides a matching allow rule AND a pre-existing sessionApproval, plan tools
full lifecycle (enter → mutation denied → plan file write allowed → exit approve flips mode →
mutation runs), unanalyzable bash skips sessionKey auto-approve, grep skip summary,
concurrency gating.

## Phase 2 — session-wiring (binding)

- `engine.ts` / `CodesplashSession`:
  - Builds the runtime at open: `createPermissionRuntime({ cwd, mode:
    options.policy?.permissionMode ?? "default", workspaceTrusted: options.workspaceTrusted ??
    true, configRules: config.permissions, overrides: options.permissionOverrides, grantsPath:
    options.permissionGrantsPath, onWarning: → warning event, onModeChange: → session.status
    event with permissionMode })`, passes it into the loop options, and includes
    `permissionMode` in the initial "ready" session.status payload.
  - Implements `setPermissionMode(mode)`: refused while a turn is active (same error style as
    setModel); "bypass" refused unless the session was OPENED with policy.permissionMode
    "bypass" (entering bypass mid-session requires the launch flag; leaving it is fine — track
    `#bypassAllowed`). Valid change → runtime.setMode (which emits via onModeChange).
  - System prompt: `SystemPromptOptions` now receives `permissionMode` and `workspaceTrusted`;
    cache key becomes modelId + mode + trusted. `prompt.ts`: when mode is "plan", append a
    short plan-mode section (read-only posture, plan file path, exit_plan_mode instruction);
    when `workspaceTrusted === false`, `discoverProjectRules` is SKIPPED entirely and the
    prompt notes that project rule files were not loaded because the folder is untrusted.
- `sessions.ts`: `SessionMeta` gains `permissionMode?: string` (loose validation like
  sandbox); add `permissionGrantsPathFor(dataDir, projectId): string` returning
  `<dataDir>/permissions/<projectId>.toml` (exported helper; no directory creation here).
- `runner.ts` (`HeadlessRunOptions` gains what it needs; parsing stays in cli.ts):
  - Passes through policy.permissionMode, permissionOverrides, workspaceTrusted,
    permissionGrantsPath into openSession; records `permissionMode` in the session meta;
    resumed runs reuse the recorded permissionMode unless overridden (same precedence as
    sandbox reuse today).
  - Trust: resolves `readTrustDecision(cwd)`; `--trust` (surfaced as `trustWorkspace: true`)
    writes trusted=true first. Untrusted/undecided → one stderr line: `Workspace not trusted:
    project rule files and .codesplash/permissions.toml are ignored (pass --trust to trust this
    folder).` and proceeds untrusted. Never an interactive prompt in run mode.
  - Auto-answer: `request.opened` with `alwaysAsk` true is DECLINED even under `--auto`, with a
    stderr note naming the command class; everything else keeps today's behavior. The runner
    never answers `acceptAlways`. Plan-approval requests (choices containing "approve") are
    answered "approve" under `--auto` and "keepPlanning" otherwise? No — headless plan
    approvals follow the same rule as approvals: `--auto` → "approve", default → "cancel"
    (decline-by-default posture; document it).

Tests: session emits permissionMode on open and on change, setPermissionMode guards (mid-turn,
bypass), prompt gains plan section / drops rules when untrusted (cache key correctness),
runner trust stderr + --trust persistence, alwaysAsk declined under --auto, meta round-trip of
permissionMode incl. resume reuse.

## Phase 2 — TUI (binding)

- **Mode cycling**: Shift+Tab cycles permission mode for codesplash sessions in
  `default → accept-edits → plan → (bypass when launched with --bypass-approvals) → default`
  order via `session.setPermissionMode`; blocked mid-turn with a status hint. Engines without
  `setPermissionMode` ignore the key. Status line shows the mode when it is not "default"
  (`PLAN`, `ACCEPT EDITS`, and `BYPASS` in the inverse style FULL ACCESS uses).
- **Trust gate** (`trust-gate.tsx`): before opening a codesplash session in a workspace whose
  trust decision is undefined, show a screen naming the resolved workspace path and what trust
  gates (AGENTS.md/CLAUDE.md injection, project permission rules); choices: `T` trust
  (persists true via writeTrustDecision) / `N` not now (proceed untrusted, nothing persisted) /
  Esc back. A persisted decision (either way — only `true` is ever persisted this tranche)
  skips the screen. The resolved trusted flag is passed as `workspaceTrusted` into openSession.
- **Bypass confirmation**: launching with `--bypass-approvals` shows a typed-confirmation
  screen in the full-access-confirmation style ("type yes") on every session open before the
  policy takes effect; declining falls back to mode "default". Never persisted.
- **/permissions overlay v2**: replaces the read-only view. Sections: mode (+ Shift+Tab hint),
  sandbox, approval policy, workspace trust state, then the merged rule list from
  `describePermissionRules` grouped allow/ask/deny with source tags
  (cli/project/user/grants/built-in). Remembered grants (source "grants") are selectable;
  `d` deletes one via `removePermissionGrant` with an inline "(applies to new sessions)" note.
  Overlay data comes from the same inputs the session was opened with (config + CLI overrides +
  grants path); an engine-agnostic session (codex) keeps the old static view.
- **Approval prompt**: renders the choice list dynamically. Key map: accept `A`, acceptForSession
  `S`, acceptAlways `P` ("always allow (persists)"), decline `D`, cancel `C`/Esc; plan review:
  approve `A`, keepPlanning `K`, cancel Esc. `alwaysAsk` requests show a "always asks" tag.
- **Resume**: codesplash resume passes the recorded meta.permissionMode into policy (explicit
  CLI override wins), and passes workspaceTrusted/grants path exactly like a fresh open. Update
  the F1/help text for Shift+Tab and the new overlay.

Tests: mode cycle order incl. bypass gating, trust gate flow (trust persists, not-now does
not), approval overlay renders acceptAlways/plan choices, status badges, permissions overlay
sections with a scripted runtime.

## Phase 3 — CLI wiring (binding)

- `cli.ts` flags (TUI root command AND `run`; `review` gets the rule/mode/trust flags too):
  `--permission-mode <plan|default|accept-edits>` (bypass is NOT a value here),
  repeatable `--allow <rule>` / `--ask <rule>` / `--deny <rule>`,
  `--bypass-approvals` (TUI only; run mode rejects it with "run mode approves with --auto;
  dangerous commands are always declined headlessly"), `--trust` (run/review only; TUI has the
  interactive gate). Rules are syntax-checked at parse time with the same regex config uses;
  violations are usage errors (exit 2). Help text covers everything; `completions.ts` static
  script gains the new flags (wiring agent owns only the flag lists there — coordinate: the
  completions module is owned by wiring in this phase since no other task touches it).
- `doctor.ts`: one permissions line — mode, rule counts per action, workspace trust state for
  the cwd (e.g. `Permissions: mode default · 2 allow / 1 deny · workspace trusted`). Never rule
  contents, never paths beyond the cwd itself.
- `review.ts`: pass-through of mode/rules/trust into runHeadless options; review still forces
  `read-only` sandbox.
- README: new "Permissions" section — modes, rule grammar with examples, precedence order,
  dangerous floor, trust gate, remembered grants, plan mode walkthrough, the honest
  policy-vs-OS-sandbox layering note. CHANGELOG bullets under Unreleased for every
  user-visible addition. `index.ts` barrel exports the new public modules.

## Acceptance

`bun run check` fully green (biome + tsc + entire suite); no new dependencies; Codex/Claude
engine behavior untouched (their sessions ignore the new policy field); keys/values never leak
into argv, logs, errors, doctor output, events, or test snapshots; every refusal message tells
the user what would allow the action; the banned word appears nowhere.
