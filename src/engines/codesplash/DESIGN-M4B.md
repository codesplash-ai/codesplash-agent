# M4 tranche B — governed context inputs (binding specification)

Extends DESIGN-M4.md after review of the private tranche plan. Baseline on `c6654c8`:
1,226 tests pass on macOS, 2026-09-06. One integrator, contracts before implementation,
focused tests during each slice, separate review/fix pass and full/platform gates at closure.
No new dependency is required. Memory is tranche C; forked skills are M7, MCP execution M6,
general competitor session/history migration M5. These are explicit boundaries, not implemented features.

## Ordered slices and ownership

1. `inputs/contracts.ts`, config, core session APIs: schemas, provenance, limits and settings.
2. `inputs/io.ts`, worker/runtime wiring, `inputs/catalog.ts`: permission-aware discovery/reads.
3. `inputs/syntax.ts`, `inputs/session.ts`: imports, mentions, templates, skills and composition.
4. Native engine/loop, shared controller/TUI: admission, approvals, commands and completion.
5. `commands/import.ts`, authoring, CLI/help/completions: explicit user migration/creation flows.
6. Source review, adversarial regression tests, full macOS/Linux and compiled smokes, docs.

Each shared file has one owner at a time. Do not copy the existing host rule loader into a new
unrestricted model-input path. Reference findings: pi's template substitution is non-recursive;
skill discovery carries source provenance and bounded metadata. Keep those properties while
using our own sandbox and permission contracts.

## Trust and loading contract

Project resources load only in trusted workspaces. Discovery returns paths, not file bodies. Fixed ancestor AGENTS.md/CLAUDE.md candidates
use host metadata checks only; their contents still require worker reads and scoped sandbox
access. No implicit ancestor-directory grant is created.
Reads run through hidden worker operations with `read_file` permission semantics; filename
search uses `glob` semantics and filters denied paths. The operations are unavailable as model
tools. File bodies are bounded before reading, sanitized before transport, and rejected if
truncated rather than treated as complete instructions. No symlink or multiply-linked resource
files; imports must remain within the permitted canonical source root. Canonicalize configured roots
before joining relative resources so macOS /var → /private/var aliases are supported. Bound discovery to
5,000 filesystem entries, resource depth 4, 128 resource files, and 48 KiB active rules.

Use the existing loop's turn admission before preparation so file approvals, cancellation and
headless refusal work before a provider request. Preparation failures do not execute the model.
No-context workspaces incur one bounded discovery pass, not a read request for every nonexistent
candidate. Configuration/policy changes invalidate the input catalog. Rescan at turn boundaries;
loaded bodies are not reused across changed permission decisions or expired grants. Rules and
command bodies already authorized during preparation are reused within that preparation only,
avoiding duplicate approval prompts; the cache is discarded before model execution.

User resources live under the exact user-owned `configDirectory()/context` subtree. The harness
may load that subtree as configuration through a separate bounded no-symlink/no-hardlink reader;
it never accepts model-selected absolute paths there or reads sibling credentials. Permission
denies still apply. Project files cannot change the user source root. Scripts referenced from
those resources still require ordinary sandbox access; configuration loading grants no execution.

## Source locations and precedence

Native project rules: root-to-cwd AGENTS.md, with existing CLAUDE.md fallback controlled by
`claudeRules` (default true). Cursor `.cursor/rules/*.mdc` is opt-in; only `alwaysApply: true`
rules auto-load, otherwise report them as inactive. Native commands:
`.codesplash/commands/*.md`; native skills: `.codesplash/skills/<name>/SKILL.md`.
Opt-in Claude `.claude/commands/*.md`, `.claude/skills/<name>/SKILL.md`; opt-in shared
`.agents/skills/<name>/SKILL.md`. User counterparts: `context/AGENTS.md`, `context/commands`,
`context/skills`. Never scan vendor credential stores in HOME.

Precedence: native project > native user > enabled vendor project; duplicate names produce
diagnostics identifying winner and shadowed path. Within rule ancestry, root precedes cwd.
Name catalog ordering is stable. An untrusted project supplies no rules, skill metadata or
commands. Resource bodies cannot change permission modes, source precedence or grant access.

`[context]` configuration: `claudeRules`, `cursorRules`, `claudeSkills`, `claudeCommands`,
`sharedSkills` booleans; `includeRoots` is an array of workspace-relative literal directories;
`personality` is `neutral|concise|explanatory` (default neutral). Imports always stay in an
allowlisted source root (workspace by default); outside-root imports fail with a configuration/
scoped-access remedy. When set, includeRoots narrows project imports to those directories; it does not widen sandbox
access. Arbitrary outside-workspace include roots are not supported in B. Ancestor rules retain
their own containing source root and still require applicable sandbox access. No directive changes the allowlist itself.

## Resource syntax and expansion

Flat YAML frontmatter subset: scalar strings/booleans and multiline `|`/`>` strings, no aliases,
tags, nested objects or executable values. Unsupported syntax is diagnosed. Skill name is
lowercase `[a-z0-9-]`, at most 64 characters; description is required and at most 1,024 characters.
Skill body is at most 6 KiB so an invocation survives the model's tool-result budget intact.
Support `disable-model-invocation` and `context: fork`; the latter refuses with the M7 remedy.
Templates are at most 16 KiB; project rule files at most 24 KiB.

`@include path` on its own line resolves relative to the containing resource. Allow quoted
paths, reject cycles, depth > 4, more than 16 included files and aggregate rules > 48 KiB.
Imports have provenance and approval; denial reports the omitted path and fails explicit
invocation, rather than silently running a partial command/skill.

Template substitutions: `$ARGUMENTS`, `$@`, `$1..$n`, `${N:-default}`, `${@:N[:L]}`. Parse
quoted arguments; reject unterminated quotes. Substitution is one pass. Arguments cannot
introduce new `!` shell or `@include` directives: discover executable spans from the template
source first. Shell expansion `!` followed by a backtick-delimited command runs through the
ordinary `bash` tool approval/sandbox path, maximum 4 commands, 10 seconds each and 8 KiB
combined output. No shell expansion during discovery, help, import preview or skill cataloguing.
An interrupted/denied expansion ends preparation without a provider request or retry.

## Mentions, skills, personalities and UI

`@path` or `@"path with spaces"` at token boundaries denotes a file mention; email addresses
and escaped `\@` are literal. Explicit mentions load bounded text through the read policy and
carry provenance separately from the original visible user prompt. Structured `UserInput.files`
is the engine contract; plain-text syntax maps to it. Aggregate mention content is capped at
48 KiB/16 files. Do not recursively interpret file content as mention/template syntax.

Filename completion uses a bounded ignore-aware `rg --files` index and deterministic fuzzy
ranking (prefix/segment matches before subsequences). Tab replaces the trailing mention with
a quoted path token. The token is the portable mention encoding; graphical pill rendering is
not required by the terminal text composer. Completion does not read file contents or grant
access; block stale async completion from overwriting changed drafts.

`/commands`, `/skills` list names/descriptions/provenance. Unknown slash commands in the native
TUI resolve against the template catalog, then fail clearly. `/skill name [arguments]` invokes
explicitly; the model `skill` tool loads only catalogued, model-invocable skills. Bodies load on
invocation; metadata alone enters the stable system catalog. No tool permissions derive from
skill frontmatter. Skill calls are read-only for plan policy but serialized because invocation can
require an approval; model invocation always rereads and revalidates frontmatter. The existing tool loop executes subsequent skill instructions normally.

Model-family guidance is selected from the model protocol/family with a generic fallback;
keep it concise and separate from personality. `/personality neutral|concise|explanatory`
changes the live session at idle, invalidating the prompt prefix, never bypassing rules.

## Explicit user migration and authoring

`codesplash import <claude|cursor> <source-dir> [--apply] [--destination DIR]` defaults to a
reviewable manifest of supported rules/skills/commands and unsupported settings/session/MCP
fields. Never print credential values. Source files are bounded, regular, unlinked files.
Apply refuses existing destination files, uses exclusive writes and rolls back newly created
files if any write fails. Record source hashes in a one-time import manifest. Never activate
MCP or migrate authentication. Imported context becomes eligible only under workspace trust
and normal context governance. Report the partial format mapping explicitly.

`/create-skill name [--write]` and `codesplash create-skill name [--write]` show a deterministic
valid SKILL.md scaffold and destination before writing. `--write` is explicit user action;
model tools cannot call the privileged authoring API. TUI writes require trusted workspace,
workspace-write and non-plan mode. Never overwrite an existing skill. Creation does not execute it.

## Acceptance

Prove no content reads in untrusted projects; deny/ask rules before loading; symlink/hardlink
and import escapes/cycles; bounded catalogs/content/shell output; injection via arguments;
literal emails/escapes; ignore-aware search and stale completion protection; precedence and
vendor opt-outs; disabled/forked skills; explicit creation/import without overwrite, with
rollback; readonly/no-history and cancellation; provider-visible provenance and prefix changes.
Run both platform suites and compiled sandbox/context-input smokes with local scripted providers.
Publish no real-model quality claims from fixture tests. Record deviations and remaining C work.
