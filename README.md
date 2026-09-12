# CodeSplash Agent

**Your entire dev workday. One terminal.** A terminal harness that drives the AI coding agents you
already pay for — OpenAI Codex natively, Claude Code through its official CLI — with your
credentials staying exactly where they are.

- **Codex, native.** Streamed responses, tool activity, live diffs, plans, interactive approvals,
  interrupt, crash recovery, and resumable sessions over the official `codex app-server` protocol.
- **Claude Code, official.** One keypress hands your real terminal to the official `claude` CLI and
  restores the harness when you leave. The app never reimplements or touches Anthropic auth.
- **Credentials stay on your machine.** The agent never reads, copies, proxies, or stores provider
  credentials. It launches the official CLIs you installed and lets them own their own auth.
- **Durable sessions.** Conversations persist locally (coalesced events, `0600` permissions, no raw
  provider payloads) and resume across restarts — or run with `--no-history` and write nothing.

## Install

Prerequisites: the agent is a harness, not the engines. Install and log in to the official CLIs you
want to drive:

- [Codex CLI](https://developers.openai.com/codex) — supported version: **0.147.0**
  (`npm i -g @openai/codex@0.147.0`)
- [Claude Code](https://code.claude.com) — tested with **2.1.228–2.1.233**

### Homebrew (macOS/Linux)

```sh
brew install codesplash-ai/tap/codesplash-agent
```

### npm (requires Bun ≥ 1.3)

```sh
npm i -g codesplash-agent   # or: bun add -g codesplash-agent
```

### Release binary (no runtime required)

Download the archive for your platform from
[Releases](https://github.com/codesplash-ai/codesplash-agent/releases), verify it, and put `codesplash`
on your PATH:

```sh
shasum -a 256 -c codesplash-agent-<version>-<os>-<arch>.tar.gz.sha256
tar -xzf codesplash-agent-<version>-<os>-<arch>.tar.gz
mv codesplash /usr/local/bin/
```

### Supported platforms

Only targets that pass real launch smoke tests in CI are advertised. Current status:

| Target | Status |
| --- | --- |
| macOS arm64 | Supported (primary) |
| macOS x64 | CI-gated |
| Linux x64 | CI-gated |
| Linux arm64 | CI-gated |
| Windows x64 | Experimental |

## Use

```sh
codesplash [path]              # open the harness in a project (defaults to cwd)
codesplash --doctor            # non-interactive diagnostics: runtime, engines, auth, paths
codesplash --no-history        # write no session files this run
codesplash --sandbox read-only # override the Codex sandbox (read-only | workspace-write)
codesplash --full-access       # run Codex without a sandbox (requires typed confirmation)
codesplash --permission-mode plan          # start in a permission mode (plan | default | accept-edits)
codesplash --allow "bash(git status *)"    # CLI-tier permission rules (--allow/--ask/--deny, repeatable)
codesplash --bypass-approvals  # skip approvals this session (requires typed confirmation)
codesplash -c theme=dark       # override one config value for this invocation (repeatable)
```

Inside a session: `/help` (or F1) shows every key binding and command — `/new`, `/resume`,
`/engine`, `/model`, `/permissions`, `/history`, `/quit`.

### Native engine

The built-in CodeSplash engine talks to the Anthropic/OpenAI APIs directly with an API key you
provide. Keys resolve environment-first (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`), then fall back to
a locally stored credential (`credentials.json` in the config directory, `0600`, never sent
anywhere else):

```sh
codesplash login anthropic             # prompts for the key — hidden input on a terminal
codesplash login openai --api-key sk-… # or pass it inline / pipe it on stdin
codesplash logout anthropic            # remove the stored key
```

`codesplash run` executes one headless turn and exits — the prompt comes from `-p/--prompt`, else
the remaining positional text, else piped stdin:

```sh
codesplash run -p "summarize this repo"
codesplash run . "fix the failing test" --auto      # path, positional prompt, auto-approve tools
git diff | codesplash run --output-format json      # prompt from stdin, one JSON result object
codesplash run -p "audit deps" --output-format stream-json --model claude-sonnet-5:high
```

Output formats: `text` (default — assistant text on stdout, tool activity on stderr), `json` (one
final `{result, turns, usage, status, sessionId}` object), `stream-json` (every event as a JSON
line, then a result line). Usage totals include an estimated cost from catalog pricing. Useful
flags: `--auto` (accept approvals; default declines them — dangerous commands are declined even
under `--auto`), `--sandbox read-only|workspace-write`, `--max-turns N`,
`--effort low|medium|high`, `--no-history`, `--permission-mode plan|default|accept-edits`,
repeatable `--allow/--ask/--deny <rule>` permission rules, and `--trust` (see
[Permissions](#permissions)). `--full-access` and `--bypass-approvals` are interactive-only
and rejected in run mode. Exit codes: `0` completed, `1` failed, `2` usage error, `130`
interrupted. `codesplash --doctor` shows which providers have credentials and their source
(`env`/`stored`) — never the values — plus any configured custom providers and the newest
session's transcript state.

#### Resuming headless sessions

Recorded `run` sessions keep an engine-owned transcript next to their event history, so a later
run can pick the conversation back up:

```sh
codesplash run --continue -p "now add tests for that"    # newest codesplash session in the project
codesplash run --resume <session-id> -p "keep going"     # a specific session by id
```

Resumed runs reuse the session's recorded policy and append to the same history
(`--no-history` with resume is a usage error). Native execution profiles are pinned:
conflicting sandbox overrides require a new session.

### Queue input and recall drafts

In native CodeSplash and Codex sessions, Enter while busy queues a follow-up. `/steer <text>` adds
direction at a safe turn boundary; `/interject <text>` interrupts and waits for cleanup first.
`/queue` opens status, pause/resume, edit, reorder, remove and retry controls. While an approval is
pending, Tab switches between its choices and the composer; typing a follow-up never answers it.
Unsupported Codex steering is reported on the queued item.

Ctrl+R or `/prompt-history` searches accepted prompts for the current project and engine. Ctrl+S
explicitly stashes the composer; `/stash` lists named drafts. Stash apply/pop refuse to replace a
nonempty draft. No-history recall and stashes remain in memory. Changed or missing attachments
require review, and inline image bytes are unavailable after restart.

```sh
codesplash session queue <id>
codesplash session queue <id> edit <input-id> "revised prompt" --apply
codesplash session queue <id> resume --apply
codesplash session history <id> search "parser"
codesplash session history <id> clear --apply
codesplash session stash <id> save draft "unfinished idea" --apply
codesplash session stash <id> apply draft
```

CLI mutations require an inactive session and preview unless `--apply` is provided. Recovered
pending inputs wait for review; possibly executing inputs require an explicit retry acknowledgment.
Single-prompt headless runs hold previous queued work. History clearing affects recall; independent
conversation records and older recovery revisions remain until session deletion.

### Branches and file recovery

`/tree` or Esc-Esc opens retained conversation boundaries. Enter previews a rewind; R applies the
reviewed selection. F creates an independent fork; `/resume` selects it. D recalls the selected
turn's retained typed prompt into an empty composer without sending it. Native compaction retains
exact earlier context. Codex uses completed provider boundaries; Claude keeps its own controls.

```sh
codesplash session tree <id>
codesplash session fork <id> <node> --apply
codesplash session rewind <id> <node>
codesplash session rewind <id> <node> --apply --revision <reviewed-revision>
codesplash session checkpoints <id>
codesplash session checkpoint-diff <id> <checkpoint>
codesplash session restore <id> <checkpoint> "selected file.txt"
codesplash session restore <id> <checkpoint> "selected file.txt" --apply --revision <reviewed-revision>
codesplash session recover-restore <id> finish --apply   # or rollback
```

The same recovery actions are live slash commands. File snapshots require Git, recorded history,
a trusted writable workspace and current permissions. Preview reports exclusions and conflicts;
restore preserves newer external edits. Conversation rewind leaves files alone. Interrupted file
restore pauses work until explicit finish/rollback. Pins (`pin-branch`, `pin-checkpoint`) and
`prune-branches` / `prune-checkpoints` use `--apply --revision`; `gc-recovery` collects orphan assets.
Only abandoned, unpinned history can be pruned. At the 1,000-boundary cap, fork into a new session.

### Export, import and change working directory

`/export` and the session CLI export the current branch ancestry, or all retained branches with
`--all`. JSON is the portable import format; Markdown and offline HTML are reading formats.
Exports sanitize credentials and omit reasoning, external tool-output files and images by default.
`--redact` also removes known workspace paths and identities; `--images` includes bounded inline
images unless sharing redaction is enabled. Review the omission report before sharing.

```sh
codesplash session export <id> --output history.json
codesplash session export <id> --format html --redact --output history.html
codesplash session import history.json --path /destination
codesplash session import history.json --path /destination --apply --sha256 <reviewed-checksum>
codesplash session foreign list codex /explicit/source/root
codesplash session foreign show claude /explicit/source/root session.jsonl
codesplash session foreign convert cursor /explicit/source/root conversation.md --path /destination --apply
codesplash import settings codex /source/config.toml     # preview supported mappings
codesplash import settings codex /source/config.toml --apply
```

Import creates a fresh native session with provenance and inherited usage. It installs no grants,
trust, jobs, queued inputs or checkpoints. Foreign discovery only reads the selected root. Supported
Codex/Claude UUID sessions in the owning CLI's configured history root can hand off with
`session foreign resume ... --apply` to that installed CLI; backups elsewhere use conversion.
its configuration and permissions apply. Cursor Markdown converts as a quoted conversation document,
without reconstructing native roles or tools; unknown SQLite layouts expose table metadata only.
Settings migration reports unsupported fields and never imports credentials or permission grants.

`/pwd` reports the execution directory. `/cd PATH` previews a native directory change; apply it with
`--carry` or `--clear`, `--apply`, and the displayed `--revision`. The CLI equivalents are
`session pwd <id>` and `session cd <id> PATH ...` for inactive sessions. Session identity stays stable;
permissions, sandbox, project memory and checkpoint scope are rebuilt for the destination. Retained
queue entries stay paused and require editing before reuse. Codex/Claude require a new session or
their own CLI to change directories.

### Session information and summaries

`/session-info` shows the live identity, working directory, policy, branch, recovery, queue,
checkpoints and cumulative versus inherited usage. Add `--copy` to explicitly copy this information
in terminals supporting OSC52. `codesplash session info <id> --json` inspects recorded information
without opening a provider; recorded policy is labelled separately from live policy.

`/recap` summarizes local turn outcomes, and `/outcomes` shows their typed records. Add
`--since SEQUENCE` to select newer activity. Completed turns also show a short summary; returning
after five idle minutes offers `/recap` without taking focus from the composer or an approval.
The derived outcome log contains counts, status, timing and observed usage, excludes conversation
text and tool bodies, and retains up to 1,000 turns. Canonical events repair a missing or damaged
cache. No-history sessions keep these records only in memory.

`/rename TEXT` sets a manual title; `/rename --auto` refreshes it from visible user conversation.
Native `/rename --generate` and `/recap --generate` explicitly request a potentially paid summary
using the current model, with no tools, bounded evidence, a 512-token output limit and a 30-second
deadline. Foreground work and close cancel pending generation; late results cannot overwrite a
manual title. Observed usage is accounted, and missing usage reports make the estimate incomplete.
Codex uses deterministic controls; Claude handoff retains its owning application's presentation.

CLI equivalents are `session recap <id>`, `session outcomes <id>` and
`session rename <id> --auto|--generate`. Native `session recap <id> --generate` uses the recorded
model. `session outcomes <id> --repair --apply` repairs the local cache under an inactive-session
writer lease. Local recaps make no model call and describe incomplete recorded turns as uncertain.

### Find and organize sessions

```sh
codesplash session list --path .
codesplash session search "parser" --engine codesplash
codesplash session rename <id> "Parser investigation"
codesplash session move <id> Work Backlog 1   # organization, section, order
codesplash session archive <id>
codesplash session list --archived
codesplash session unarchive <id>
codesplash session reindex --apply
codesplash session compress <id>             # preview; add --apply to compress
codesplash session delete <id>               # preview; add --apply to delete local history
```

Use `--json` for structured output and `--limit 1..100 --offset N` for pages. Search covers
sanitized titles and user/assistant conversation text; it excludes reasoning and tool payloads.
The session picker offers `/` search, `a` archived visibility, `r` rename, `h` archive/unarchive,
`d` deletion preview, and Page Up/Down. Archives still count toward usage statistics.
Organizations and sections do not change the working directory, repository trust or permissions.

Session files remain the recoverable source; SQLite is a rebuildable index. Cold logs use checked
gzip representations and resume automatically materializes them. Compression supports logs up to
64 MiB each. Maintenance refuses active or foreign-host owners. Unknown/network filesystems permit
inspection with a local derived cache; writing history requires verified local storage.

For legacy history, close the old application, inspect `session migrate <id>`, then apply it with
`--apply`. An interrupted legacy session first needs `session recover <id> --apply`. Recovery does
not replay tool calls or approvals. Migration preserves a metadata backup and writes version 2
metadata, which older builds cannot resume. Deletion removes local history and search projections;
provider threads and independently stored repository memories remain separate.

### Long sessions and context

The native CodeSplash engine automatically shortens old tool results and summarizes older
conversation context when a request approaches the model's input budget. `/compact [instructions]`
does this manually; `/context` shows estimates for system instructions, tools and messages,
the output reserve, last measured input, and changes to the prompt prefix. Estimates, especially
for images, are approximate; recognized provider context-overflow errors get one bounded retry.

```toml
[codesplash]
autoCompact = true                 # false requires manual compaction
compactionStrategy = "summary"      # "prune" only shortens older tool results; no summary call
```

Summaries use your selected provider and count toward session usage and estimated cost. Each
operation allows at most four summary requests, 2048 output tokens per request and 60 seconds
total; automatic work allows at most two such operations per turn. Summaries cannot run tools.
Esc interrupts manual compaction. If context still cannot fit, the engine explains how to
continue with a smaller prompt, larger-context model or new session.

Compaction replaces older **model-visible native history** with a summary and recent messages.
The visible conversation event history remains intact. Atomic saves make the compacted context
resumable; pre-compaction native messages are not separately archived. Summaries can omit detail,
so inspect the visible history or original files when exact evidence matters.

Tool results above 8 KiB receive an opaque reference for `read_tool_output`. The session retains
up to 16 MiB/256 results, evicting oldest entries as needed. These are sanitized results within
the tools' existing execution caps, not unlimited raw output. With history enabled they live
beside the native transcript; with `--no-history` they remain in memory and expire with the
session. Context epochs and prefix diagnostics describe the current live session. These native
features leave Codex and Claude's own context management with their respective engines.


### Repository memory (native engine)

`/remember Use transactional parser updates` saves an explicit fact for this repository.
`/memory` lists facts and pending candidates; use `show ID`, `search QUERY`, `edit ID TEXT`,
`forget ID`, and `accept ID` to inspect or change them. Generated candidates stay inactive
until you accept them and retain their provenance afterward. `/context` shows the selected
memory contribution. Stored text is reference data and cannot grant permissions or execute.

The same controls are available outside a session:

```sh
codesplash memory remember --trust "Use transactional parser updates"
codesplash memory search parser
codesplash memory status
codesplash memory repair
codesplash memory extract --model MODEL
codesplash memory consolidate --model MODEL
```

`--path DIR` chooses the repository; `--read-only` permits retrieval but refuses durable changes.
Use `--` before literal text containing command flags. Trust is required; `--trust` records your
explicit decision. `--no-history`, disabled history, or `memory.enabled = false` disables durable
memory reads, writes and learning. Plan mode permits retrieval and ephemeral session notes.

Memory lives under the application's data directory in `memory/<repository UUID>/`: readable
Markdown records referenced by an atomic manifest, plus a rebuildable SQLite FTS5 index.
Git worktrees share repository facts; generated observations remain scoped to their worktree.
Clones stay separate. After moving a repository, `memory link UUID` previews linking its previous
identity; `memory link UUID --apply` applies it, refusing to abandon a nonempty current store.
Use the commands for edits so revisions and indexes stay consistent. `repair` rebuilds the index
and removes unreferenced crash leftovers; it never resurrects deleted facts.

Keyword search works without a provider. Optional semantic retrieval needs explicit configuration:

```toml
[memory]
enabled = true
autoLearn = false

[memory.embedding]
url = "https://YOUR_ENDPOINT/v1/embeddings"
model = "YOUR_EMBEDDING_MODEL"
keyEnvVar = "MEMORY_EMBEDDING_KEY"
dimensions = 1536
# inputPerMTok = 0.10  # set your endpoint's actual price, or cost remains unknown
```

The endpoint must also pass the existing network allowlist and `web_fetch` permission rules.
Keep the key in its named environment variable. Searches cache at most 15 new fact vectors per
request; `memory index` explicitly builds the next batch of up to 16 and reports how many remain.
Only indexed facts participate in semantic search. Edits and repair rebuild derived state;
use `memory index` to repopulate vectors. Endpoint failures fall back visibly to keyword search.
No embedding requests occur unless configured. Queries and selected fact text are sent to that
endpoint; input tokens and configured cost appear separately in `/usage`.

Automatic learning is **off by default**. Setting `autoLearn = true` permits bounded idle
extraction/consolidation using the session's selected model. Foreground work and shutdown cancel
it. Explicit `extract` uses current-session evidence (the latest native session for the CLI);
`consolidate` reconciles pending candidates without replacing curated facts. Calls have no tools,
a 60-second total deadline and accounted token usage. Inspect candidate claims before accepting
them; fixture tests establish mechanics, not factual quality or perfect secret detection.

Model tools `memory_search`, `memory_read`, `memory_write`, `session_notes` and `history_read`
provide scoped access. Candidate writes and recorded-history recovery use the normal approval
flow. Notes are bounded to 16 per session and restored on resume; they remain ephemeral under
no-history or read-only mode. Recovery reads only bounded user/assistant evidence from the current
session. General session search, organization and migration belong to the next milestone.


### Rules, file mentions, commands and skills

Trusted native workspaces load `AGENTS.md` from the repository root down to the working
folder, with `CLAUDE.md` as the fallback in each directory. Every body read uses the read
permission policy. Ancestor rules outside the session's sandbox roots require configured
read access; opening the session at the repository root avoids that extra boundary.
Untrusted projects supply no automatic rules, commands or skill metadata.

Attach a text file with `@src/file.ts` or `@"path with spaces.md"`. Tab completes a trailing
file mention using an ignore-aware filename search. Attachments stay within the workspace,
with at most 16 files, 24 KiB per file and 48 KiB combined. Email addresses and escaped
`\@mentions` remain literal. Attached contents are file data; they are not expanded again.

Create a Markdown command at `.codesplash/commands/review.md`, then invoke `/review arguments`.
`/commands` lists templates and their sources. Templates support `$ARGUMENTS`, `$@`, `$1`,
`${2:-default}` and `${@:2:3}` substitutions. Static `@file` references attach workspace files.
Shell spans such as !`git status --short` use the ordinary bash approval and sandbox flow;
arguments become shell positional parameters, so they cannot introduce new executable spans.
There are at most four shell expansions, each limited to ten seconds, with 8 KiB output combined.

Skills live at `.codesplash/skills/<name>/SKILL.md`:

```markdown
---
name: verify
description: Review changes and verify the relevant behavior.
disable-model-invocation: true
---
Read the changed files, identify affected behavior, and run the relevant checks.
```

`/skills` lists skills and sources; `/skill verify arguments` invokes one explicitly. Without
`disable-model-invocation: true`, the model can load the skill through its `skill` tool.
Only metadata enters the initial prompt; invocation loads the body. Frontmatter uses a flat
subset of YAML (strings, booleans and multiline strings), and skill bodies are limited to 6 KiB.
Skill instructions grant no permissions. `context: fork` executes an owned native child with fresh context and the parent’s permission ceilings. `/create-skill name` previews a scaffold; adding `--write` creates it.

User-wide counterparts live under `context/` inside the CodeSplash configuration directory:
`context/AGENTS.md`, `context/commands/*.md`, and `context/skills/<name>/SKILL.md`. For duplicate
command or skill names, native project resources win over user resources, then vendor resources.
These settings opt into vendor locations and choose the response style:

```toml
[context]
claudeRules = true                 # CLAUDE.md fallback; enabled by default
claudeCommands = false             # .claude/commands/*.md
claudeSkills = false               # .claude/skills/<name>/SKILL.md
cursorRules = false                # .cursor/rules/*.mdc with alwaysApply: true
sharedSkills = false               # .agents/skills/<name>/SKILL.md
personality = "neutral"            # neutral, concise, explanatory
# includeRoots = ["docs"]          # restrict @include to these workspace-relative directories
```

`/personality concise` changes the live session style at idle. An `@include path` line loads
instructions relative to the containing resource, only within its allowed source roots and
after explicit approval. The default root is the workspace (the fixed configuration subtree
for user resources); `includeRoots` narrows project imports. Imports reject cycles, symlinks,
hardlinks and excessive size/depth. Headless runs refuse imports requiring an interactive decision.

Migration and authoring are preview-first CLI commands:

```sh
codesplash import claude /path/to/source --destination /path/to/project
codesplash import cursor /path/to/source --destination /path/to/project --apply
codesplash create-skill verify
codesplash create-skill verify --write
```

Import maps supported rules, commands and skills, records source hashes, and reports unsupported
settings fields without their values. It never overwrites existing files, migrates credentials,
or activates MCP. Supported agent definitions import disabled and require fingerprint review before activation.
`debug prompt` uses the governed loader too; reads that need approval require an interactive session.

#### Custom providers (BYOK)

Any OpenAI- or Anthropic-protocol endpoint can serve models through `[providers.*]` tables in
`config.toml` — for example a local Ollama:

```toml
[codesplash]
fallbackModel = "gpt-5.1"           # optional: retried once when the primary provider errors

[providers.ollama]
protocol = "openai"                  # wire protocol: anthropic | openai
baseUrl = "http://localhost:11434/v1"
requiresKey = false                  # default true; keys come from OLLAMA_API_KEY (never config)

[[providers.ollama.models]]
id = "qwen3:8b"
displayName = "Qwen3 8B"
contextWindow = 32768
```

API keys never live in `config.toml` — a `key`/`apiKey` field there is rejected with a pointer at
the provider's env var. Custom models appear in `/model` and are valid `--model` selectors.

#### Web tools

The engine ships `web_fetch` (fetch a URL as markdown/text, SSRF-guarded, 5MB cap, redirects
re-validated per hop) and `web_search` (DuckDuckGo HTML results). Both are read-only, allowed
under the read-only sandbox, and require approval per host/search under untrusted approvals.

#### More subcommands

```sh
codesplash review                      # review uncommitted changes in one read-only turn
codesplash review --base main          # …changes since a ref, or --commit <sha> for one commit
                                       # reviews always start in permission mode "default" —
                                       # config [permissions].mode is deliberately ignored;
                                       # pass --permission-mode to choose one explicitly
codesplash stats --days 7 [--json]     # recorded usage per engine+model: sessions, tokens, cost
codesplash completions fish            # shell completion scripts: bash | zsh | fish | powershell
codesplash debug prompt                # the model-visible surface (system prompt, tools) as JSON
```

#### Per-invocation config overrides

Every config-loading command (the TUI, `run`, `review`, `debug prompt`) accepts repeatable
`-c/--config dotted.path=value` overrides, applied for that invocation only and never written
back:

```sh
codesplash -c theme=dark
codesplash run -p "quick check" -c codex.sandbox=read-only -c codesplash.fallbackModel=gpt-5.1
```

Configuration resolves in this order: defaults, user `config.toml`, the trusted workspace's
`.codesplash/config.toml`, the selected profile, supported environment variables, then `-c`.
Untrusted workspace configuration is skipped. Tables merge; scalars and arrays replace, except
permission `deny` and `ask` rules accumulate. Empty ordinary arrays clear inherited arrays.

```toml
# In your user config.toml:
[profiles.careful]
theme = "dark"
[profiles.careful.permissions]
mode = "plan"

[profiles.review]
extends = "careful"
[profiles.review.codesplash]
autoCompact = false
```

```sh
codesplash --profile review
codesplash config explain --path /path/to/project --profile review
codesplash config validate --strict-config
codesplash config profile list
codesplash config profile select careful  # persist a user-defined default profile
codesplash config schema                  # print the JSON schema
```

`--profile` overrides `CODESPLASH_PROFILE` and the top-level `profile` setting. The supported
environment overlays are `CODESPLASH_THEME`, `CODESPLASH_MODEL`, `CODESPLASH_HISTORY` (`true` or
`false`), and `CODESPLASH_PERMISSION_MODE`. No shell expansion or arbitrary environment import
occurs. `--strict-config` rejects unknown fields; `config explain` reports source fingerprints,
per-field contributors and diagnostics. Theme and permission edits preserve profiles and unknown
tables, retaining the previous source in a private `config.toml.backup` file.

`CODESPLASH_CONFIG` also accepts up to 64 KiB of JSON or TOML containing only
`theme`, `models.codesplash`, `history.enabled`, and `permissions.mode`. The individual
environment variables override that inline overlay.

An optional `managed.toml` beside the user config sets a separate local policy ceiling:

```toml
sandboxModes = ["read-only", "workspace-write"]
permissionModes = ["plan", "default"]
deny = ["bash(curl *)"]
allowedHosts = ["example.com:443"]
environment = ["CI"]
[required.codex]
approvalPolicy = "untrusted"
```

Managed host/environment lists restrict configured grants; they do not grant access. Mode
restrictions also apply to launch flags and runtime mode changes. Unknown managed fields fail
closed. This is local harness policy, editable by the OS account that owns the file. Project trust
does not approve executable extensions or hooks. Configuration changes apply at the next runtime
open or working-directory transition; recorded sandbox profiles must remain compatible.

Codex settings import also previews model defaults inside named profiles. Imported profiles stay
unselected; unsupported execution and credential settings are reported without their values.

### Native MCP servers

Add servers as inactive entries, inspect the configuration and executable fingerprint, then
trust that exact fingerprint. Offline `list` and `show` do not start servers.

```sh
codesplash mcp add local -- /absolute/path/to/server --literal-argument
codesplash mcp enable local
codesplash mcp show local
codesplash mcp trust local --fingerprint HASH_FROM_SHOW
codesplash mcp doctor local --connect
codesplash mcp login remote     # explicitly configured OAuth; prints a consent URL
codesplash mcp logout remote    # removes local credentials, including prior source generations
```

Use `--scope project` to edit `.codesplash/config.toml`, or the default `--scope user`.
Edits preserve unrelated settings and retain a backup. Source changes require a fresh trust
review. Foreign MCP settings import creates inactive entries; credential/environment settings,
unsupported definitions and existing-name collisions require manual review.

```toml
[mcp.servers.remote]
transport = "http"             # Streamable HTTP; "sse" explicitly selects legacy SSE
url = "https://example.org/mcp"
enabled = false
allowTools = ["search", "create_issue"]
denyTools = []
readOnlyTools = ["search"]      # your reviewed assertion; server hints do not grant this
bearerEnv = "EXAMPLE_MCP_TOKEN" # reference only; omit when using OAuth
# [mcp.servers.remote.oauth]
# clientId = "public-client-id" # optional configured client; otherwise dynamic registration
# scopes = ["read"]
```

Stdio uses the native OS sandbox, literal arguments and explicitly allowed non-secret environment
names. `trustFiles` includes additional script/dependency trees in executable review. HTTP/SSE
and OAuth metadata/token requests use the configured sandbox host grants. Literal loopback HTTP
fixtures require `allowLoopback = true`; other private destinations are refused. Stdio credentials
are not injected through the non-secret `environment` list.

In a native session, `/mcp` shows configured servers and active generations. `/mcp disable ID`
closes a session connection; `enable ID` or `reconnect ID` connects an already enabled, trusted
source. These session commands leave persistent configuration alone. Permission-mode changes,
branch selection and source invalidation discard connections or selections; reconnect explicitly.

The model uses `search_tool` (keywords or `select:server/tool`) to load bounded schemas, then
calls the selected name or `use_tool`. Both routes check the actual namespaced operation and
current generation. `mcp_resource` lists resources/templates or reads a server URI. Images are
validated native attachments; other bounded binary content retains MIME/base64/provenance.
Resource identifiers never grant local file or arbitrary network access. Tool allowlists also apply
to `resources/list`, `resources/templates/list` and `resources/read`; include the intended resource
operations when restricting a server. External mutations are
not undone by workspace checkpoints, and uncertain operations are never automatically retried.

Form elicitation uses a separate validated editor. Headless runs decline forms, including under
`--auto`; an embedding consumer may answer the typed request. Credential-shaped and unsupported
forms are refused. OAuth requires protected OS storage; systems without a credential service
refuse durable login. Logout removes local credentials and does not revoke remote tokens.

### Native lifecycle hooks

Hooks run reviewed command or HTTP handlers at live session, input, turn, tool, permission,
compaction, child lifecycle and resource/config/directory/branch boundaries. History replay never runs handlers.
Declare handlers in user or trusted project configuration; they are disabled by default:

```toml
[hooks.handlers.check]
kind = "command"
command = "/bin/sh"
args = ["/absolute/path/check.sh"]
events = ["tool.before"]
matchTools = ["bash"]
share = ["input"]
timeoutMs = 10000
once = "never"
```

```sh
codesplash hooks list
codesplash hooks enable check
codesplash hooks show check
codesplash hooks trust check --fingerprint HASH_FROM_SHOW
```

`show` reviews the program, dependency files, source configuration, sharing and policy without
execution. Add non-argument dependencies to `trustFiles`. Changed executable/configuration content
requires another review. Project trust alone does not authorize a handler. `--scope project` selects
the project file for edits; `--path`, `--profile`, `-c` and `--strict-config` support inspection.

Commands receive one version-1 JSON document on stdin and return a version-1 JSON object, or empty
stdout. For example, `{"version":1,"decision":"deny","reason":"Explain the required change"}` refuses
a gate; exit 2 also refuses command gates. A failed/timed-out gate blocks its operation. Observational
failures produce diagnostics; post-tool processing preserves the already-recorded actual outcome.
Inputs and outputs are capped at 128 KiB each, with retained context previews and session quotas.

Only declared `share` fields are supplied: `text`, `input`, `result`, `cwd`, `reason`, `transition`.
Metadata carries event/operation ids and actual tool/source identity. Credentials and provider
reasoning are not implicit payloads. Exact tool/source matchers or one `*` glob are supported.
Handlers use a fixed OS sandbox and declared non-secret `environment` grants. `writeWorkspace = true`
requests writes inside the workspace, still restricted by the active mode; temporary tool grants
never carry over. Command hooks require enforced sandboxing, including when the session otherwise
uses full access. HTTP handlers use `kind = "http"`, `url` and optional `bearerEnv`; fixed network
grants and DNS checks apply. POST redirects/retries are refused, and HTTP hooks cannot run in
plan/read-only mode because their remote effects are unknown.

Rewrites require reviewed capabilities: `allowTextRewrite` for `input.admit`, `allowInputRewrite`
for `tool.before`, and `allowResultRewrite` for post-tool events. Rewritten inputs are validated
before final permissions, target extraction, checkpoints and execution. `allowDefaultApproval`
applies only to an ordinary default prompt; explicit ask/deny and dangerous floors remain binding.
`allowContinuation` enables `turn.stop` requests within `[hooks.continuation]`: at most eight,
120 seconds, and a token allowance (default 32768). Foreground input, interruption, provider failures
and harness limits take precedence. Native children dispatch `subagent.start` and `subagent.stop`
with their task and agent origin through the same reviewed hook runtime. Prompt/agent hook engines
are not supported.

`async = true` supports observation only, with at most four owned async handlers. `once = "turn"`
or `"session"` applies per handler fingerprint and event. Intent receipts prevent replay of uncertain
execution; a once denial remains a denial. `/hooks` shows status/review and recent activity;
`/hooks reload` stages reviewed sources, and `/hooks disable ID` stops a session handler. Use
`/hooks receipts` and `/hooks acknowledge KEY` to inspect/consume uncertainty. If startup itself is
blocked, use `codesplash hooks receipts --session ID` and `codesplash hooks acknowledge KEY --session ID`.
Acknowledgment does not retry an effect. No-history receipts and retained outputs stay in memory.

Foreign settings import maps supported command/HTTP declarations to disabled handlers. It reports
unsupported shell expansion, regex matchers, credentials, async/prompt/subagent behavior and collisions.
Adapt handlers to the native version-1 input/output protocol before enabling: foreign permission,
stop-blocking, `hookSpecificOutput` and rewrite semantics are not translated automatically.

### Permissions

The native CodeSplash engine runs every tool call through a policy layer: permission modes,
allow/ask/deny rules, a dangerous-command floor, workspace trust, and remembered grants.

**Modes** — cycle with Shift+Tab in a session, set with `--permission-mode` or
`[permissions].mode` in config.toml:

- `default` — each tool's normal approval flow (file writes and commands ask as configured).
- `accept-edits` — file edits inside the workspace run without asking; everything else as default.
- `plan` — read-only investigation: mutating tools are refused, the model writes its plan to
  `.codesplash/plan.md` and calls `exit_plan_mode`, and you approve the plan before any change.
  The intrinsic `enter_plan_mode`/`exit_plan_mode` tools let the model propose this itself.
- `bypass` — no approvals. Only reachable with `--bypass-approvals` (interactive only, typed
  confirmation on every session, never persisted). The dangerous-command floor and the
  self-protection write floor still apply.

**Rules** — `tool` or `tool(pattern)` strings in three actions (`allow`, `ask`, `deny`):

```toml
[permissions]
mode = "default"
allow = ["bash(git status *)", "web_fetch(*.example.com)"]
ask = ["bash(npm *)"]
deny = ["read_file(**/*.secret)"]
```

Pattern semantics depend on the tool: `bash` patterns match the command's words with a trailing
`*` wildcard (`bash(git status *)` allows `git status --short` but not `git push`); file tools
(`read_file`, `write_file`, `edit_file`, `apply_patch`) take globs matched against both relative
and absolute paths — symlinks are resolved first, so a deny rule cannot be dodged through a link
and an allow rule never vouches for whatever a symlink points at; `web_fetch` takes a hostname,
exact or `*.suffix` (deny rules are also re-checked on every redirect hop). Every other tool
supports only the bare form. The same rules are repeatable CLI flags — `--allow <rule>`, `--ask <rule>`,
`--deny <rule>` — checked at parse time (a bad rule is a usage error, exit 2).

**Precedence** (first hit wins): the self-protection write floor (`.git`, harness config/data
directories, `~/.ssh`, `.codesplash/` except `plan.md` — enforced in every mode, bypass and full
access included) → explicit `deny` → the dangerous-command floor → explicit `ask` → explicit
`allow` → built-in sensitive-read denials (`.env`, private keys, `*.pem`, … — an explicit allow
rule overrides them) → mode defaults. Rules merge across four tiers: CLI flags, the project's
`.codesplash/permissions.toml` (trusted workspaces only), your `config.toml`, and remembered
grants; `/permissions` in the TUI shows the merged list with each rule's source.

**Dangerous floor**: destructive command shapes — `sudo`, `rm -rf`, `dd of=/dev/...`, forced
`git push`, `curl | sh` pipes, and friends — always ask, in every mode, cannot be remembered,
and are always declined headlessly (even under `run --auto`). The floor looks through git
global flags (`git -C . push --force`) and recurses into `bash -c '...'` strings; a command
the analyzer cannot parse at all (substitution, backticks, an opaque interpreter string) is
treated the same way — it always asks and is declined headlessly, since it could hide any of
the above.

**Workspace trust**: the first interactive session in a new folder asks whether to trust it;
until trusted, project rule files (AGENTS.md/CLAUDE.md) and `.codesplash/permissions.toml` are
not loaded. Headless runs never prompt — they proceed untrusted with one stderr notice, and
`run --trust` / `review --trust` persists trust for the folder.

**Remembered grants**: interactive approvals can offer "Always allow", persisting a derived rule
(e.g. `bash(git status *)`) per project under the harness data directory. Applies from the next
matching call; delete grants from the `/permissions` overlay. Dangerous-floor approvals are
never rememberable, shell-interpreter prefixes (`bash(bash *)`) are never derived, and a
file-tool grant is refused when its parent directory would blanket `/`, a top-level directory,
or the home directory.

**Native execution sandbox**: macOS Seatbelt and Linux bubblewrap/seccomp enforce filesystem
and network restrictions for shell commands, descendants, and file-tool workers. Approval
rules permit an attempt within that boundary. Bypass approvals does not disable it. Missing
dependencies or an incompatible enclosing sandbox refuse execution without an unrestricted
retry. Native Windows isolation is not available yet.

macOS needs `sandbox-exec` and ripgrep. Linux needs `bubblewrap`, `socat`, ripgrep, and a host
policy permitting unprivileged user namespaces; the release includes a verified seccomp
helper. Homebrew installs the platform dependencies. `codesplash --doctor` probes execution;
`/permissions` shows the active profile and the last observed enforcement state.

```sh
codesplash sandbox --no-history -- /bin/sh -c 'printf ok > sandbox-check.txt'
codesplash sandbox --read-only -- /bin/ls
codesplash sandbox --allow-host example.com:443 -- curl https://example.com
```

The wrapper preserves arguments after `--` literally. `--read-root PATH` and
`--write-root PATH` add absolute roots for that invocation. Native sessions can configure
`readRoots`, `writeRoots`, `allowedHosts` (exact `hostname:port`), and `environment` (non-secret
variable names) under `[sandbox]`. The base profile is pinned when a session opens; conflicting
configuration on resume requires restoring it or starting a new session. Legacy sessions get
an explicit migration notice. Temporary grants are never restored on resume.

Tool network access requires exact host grants. The `request_permissions` tool asks for an
explicit read, write, or network capability lasting one turn or the live session. Headless
`--auto` and guardian reviews cannot grant it. A grant never automatically retries a command.
Direct network bypasses, private-address destinations, and unsupported protocols remain
blocked. The exact `.codesplash/plan.md` file is the only workspace write exception in plan mode.
Sensitive-file kernel exclusions still apply when a permission rule allows a read.

Named secrets use the OS keyring: `codesplash secrets set DEPLOY_TOKEN` reads hidden input
(or stdin); `codesplash secrets list` lists names, and `codesplash secrets delete DEPLOY_TOKEN`
removes one. Each tool binding requires approval showing the name and complete command.
Values are filtered from tool output before truncation and persistence. There is no plaintext
fallback if the keyring is unavailable. Redaction does not prevent a deliberately encoded
secret from being disclosed by an approved command.

`[guardian] enabled = true` enables optional bounded model review of eligible default prompts.
It is off by default; explicit ask/deny rules, dangerous-command prompts, and secret/access
approvals retain their normal behavior. Timeout, cancellation, and malformed reviews do not
approve execution. `/permissions add|delete|replace user|project|grants allow|ask|deny RULE`
edits writable rules; replacement uses `OLD => NEW`. The overlay labels rule sources and
reports definite conflicts.

For development on this repository, use `bun run dev`: it runs a private copy of the harness
so tools can edit this checkout while the running supervisor stays protected. Workspaces
with hardlinks reaching outside their admitted roots are refused; use a separate copy or
install dependencies with `bun install --backend=copyfile` if needed. The boundary covers
tool execution; the trusted harness and concurrent unconfined host programs remain outside it.

Bun 1.3.14's script launcher can report `CouldntReadCurrentDirectory` when ancestor directories
are unreadable. `npm run build` is verified inside this sandbox; invoking a script directly
with `bun path/to/script.ts` also avoids that launcher behavior. See the [Bun issue](https://github.com/oven-sh/bun/issues/28220).

## Security posture

- No provider OAuth implementation, no reading `~/.claude` or Codex credential stores, ever.
- Codex defaults to `workspace-write` sandbox + interactive approvals; full access requires an
  explicit flag **and** a typed confirmation on every session, and is never a persisted default.
- Session history stores normalized events only — raw provider payloads and credential-shaped
  content are stripped or redacted at source; files are `0600`, directories `0700`.
- `--no-history` disables all persistence for a run.

## Uninstall

The app owns no credentials, so uninstalling is deletion:

```sh
brew uninstall codesplash-agent      # or: npm rm -g codesplash-agent, or delete the binary
# optional — remove local config and session history:
#   macOS:  ~/Library/Application Support/codesplash-agent
#   Linux:  ~/.config/codesplash-agent and ~/.local/share/codesplash-agent
#   Windows: %APPDATA%\codesplash-agent
```

## Rollback

Every release is a versioned, checksummed artifact. To roll back, install the previous tag from any
channel, e.g. `npm i -g codesplash-agent@<previous>` or download the earlier release archive.

## License

[Business Source License 1.1](./LICENSE) — free for personal and non-production use; commercial
offering of the work requires a license from CodeSplash. Converts to Apache-2.0 on 2030-08-16.

### Trusted native extensions

Native TS/JS extensions use API v1 to register tools, streaming providers/models,
auth callbacks, live lifecycle observers, commands, typed flags and UI contributions.
They run **inside the harness process with its privileges**. Only load code you
trust. The subprocess sandbox does not confine extension imports or direct I/O;
JavaScript cannot forcibly terminate a synchronous infinite loop.

Give each extension a dedicated directory containing its entry, dependencies and
assets. Package dependencies must already be installed; review never installs or
imports code. All files are fingerprinted, with limits of 4096 entries / 512 MiB;
symlinks and ordinary imports outside that directory are refused.

```toml
[extensions.entries.example]
root = "/absolute/path/to/my-extension"
entry = "index.ts"
enabled = false

[extensions.entries.example.flags]
greeting = "Hello"
```

```js
export default (api) => {
  const greeting = api.registerFlag("greeting", { type: "string", default: "Hello" });
  api.registerTool({
    name: "greet", description: "Return a greeting", readOnly: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_input, context) {
      context.progress("Preparing greeting");
      return { text: greeting, label: "Greeting" };
    },
  });
  api.registerCommand({
    name: "hello", description: "Prepare a greeting draft",
    async run() { return api.ui.composer(greeting) ? "Draft prepared" : "Composer unavailable or occupied"; },
  });
  api.on("turn.end", () => { api.ui.status("greeting", "Greeting extension ready"); });
}
```

Enable, inspect the complete review, then explicitly trust that fingerprint:

```bash
codesplash extensions enable example
codesplash extensions show example
codesplash extensions trust example --fingerprint <reviewed-hash>
```

`--scope project` selects the project configuration for edits. Changes to code,
dependencies, configuration sources or policy invalidate trust. Tool identities
are `ext_ID_24hex`; inspection with `/extensions status` lists the actual names.
Calls use ordinary permissions, C hooks, output limits and workspace checkpoints.
Direct extension I/O and remote effects cannot be rolled back by those checkpoints.
Overrides require explicit `overrides = ["read_file"]` selection, preserve the
original schema and policy floor, and cannot replace protected intrinsics.

Per-invocation flags use the existing `-c extensions.entries.example.flags.greeting=Hello` override.
Use `/extensions run example/hello`, `/extensions status`, `/extensions disable
example` or `/extensions reload`. Tab completes arguments when a command supplies
completions. Reload stages registrations before replacing the current tools;
provider registration changes require a new session. Different sessions and
activations load separate snapshots of ordinary module/dependency state. Process
globals and direct effects cannot be unloaded or reversed. Callback failures
quarantine their owner. Session transitions cancel owned work and timers.

UI v1 supports attributed status/widget text, correlated form dialogs and replacing
an empty idle composer. Headless dialogs return `unsupported`; they do not invent
answers. Auxiliary `api.complete(model, prompt)` calls are tool-free, accounted,
cancellable and limited to eight requests per turn/command budget with at most
8192 output tokens per request. Providers register namespaced models and may supply
an auth callback for their own credential; no API exposes other providers' keys.
Unknown pricing remains explicitly unpriced.

For recovery, launch with `codesplash --no-extensions` or
`codesplash run --no-extensions ...`. This skips extension imports even if enabled
by configuration. C command hooks remain the option for OS-enforced external code.
The public embedding package is described separately from this extension API.
Plugin distribution and activation are described below.

### Plugins and marketplaces

A native plugin is a dedicated directory with one `codesplash-plugin.json`:

```json
{
  "schemaVersion": 1,
  "api": 1,
  "id": "example",
  "version": "1.0.0",
  "description": "Example resources and extension",
  "skills": ["skills/example/SKILL.md"],
  "commands": ["commands/example.md"],
  "extensions": { "main": { "entry": "extension.ts" } }
}
```

`hooks` and `mcp` are named native handler/server tables. Use `${PLUGIN_ROOT}/file`
for package paths in process arguments; command names such as `bun` resolve normally.
`agents` lists native `agents/name.md` child definitions. A selected plugin must pass its existing integrity checks before a definition can run.
LSP declarations are rejected explicitly. Native manifests are required; foreign
plugin APIs are not automatically converted.

```sh
codesplash plugin install ./example
codesplash plugin install 'git:https://example.org/team/plugin.git#FULL_40_CHARACTER_COMMIT'
codesplash plugin install npm:example-plugin@1.2.3
codesplash plugin list
codesplash plugin show example
codesplash plugin enable example
```

Installation copies verified files into a private immutable version directory and
records source, dependencies and integrity. Packages start disabled. Enabling does
not grant executable trust: `plugin show` lists the generated component IDs; use
`extensions show/trust`, `hooks show/trust` or `mcp show/trust` with each current
fingerprint before activation. Trust receipts distinguish immutable plugin versions,
so reviewing an update does not revoke the version still in use by another session.
Native extensions have full harness-process privileges.
Plugin skills/commands enter normal resource discovery with plugin attribution and
existing permissions, collision handling and context limits.

Use `/plugins status` and `/plugins reload` in a native session. Reload requires idle
admission and stages all contributions before publication. Failed staging preserves
the old version; queued inputs discover resources again after publication. Provider
registration changes require a new session. Versions remain pinned until explicit
reload or a working-directory replacement; modified installed files fail integrity
checks. Use `plugin disable ID` or reinstall to recover a damaged installed tree;
management remains available without loading package contributions. `--no-extensions` remains the recovery path for faulty extension code.

`plugin update ID [SOURCE]` installs a new disabled version. `plugin rollback ID HASH`
selects a retained version, also disabled. `plugin disable ID` or `plugin remove ID`
detaches configuration; old immutable versions, credentials and recorded sessions
remain available to existing owners. Use `--scope project --path DIR` to edit a
project source; trusted project configuration is required for its activation.

Dependencies use Bun on PATH, an isolated registry configuration and `--ignore-scripts`.
Only npm semantic version dependencies pass the bounded registry proxy; Git/file
transitive dependencies are rejected. The default registry is `https://registry.npmjs.org`;
`--registry URL` selects another HTTPS origin. `--allow-loopback` is an explicit local
fixture option. Downloads require SHA-512 integrity. Packages are limited to 4096
entries, 16 MiB per file and 128 MiB expanded, with 32 MiB archives, 64 resolved
dependencies and 120-second acquisition deadlines. Links and archive traversal are
rejected. Generated install caches and executable links are excluded from versions.

Installation does not run lifecycle or build scripts. To execute a reviewed build,
use `plugin build ID --fingerprint HASH -- COMMAND ARGUMENT...`. This runs literal
argv against a private copy with host privileges, bounded time/output and owned process
cleanup. Its external effects cannot be rolled back. Success publishes a new disabled
version; failure preserves the selection. Review and trust the resulting executable
fingerprints again. Build tools can be invoked by their explicit package file paths.

A marketplace uses `codesplash-marketplace.json` with `schemaVersion: 1`, an `id`,
and `plugins: { "name": { "source": "npm:package@1.2.3", "description": "..." } }`.
Sources may also be pinned Git URLs or `./relative-package` directories inside the
marketplace snapshot. Manage it with `plugin marketplace add SOURCE`, `list`,
`show ID`, `update ID [SOURCE]` and `remove ID`; install via `plugin install name@market`.
Browsing never executes package code. Managed `pluginIds`, `marketplaceIds` and
`pluginPins` (`ID/SHA256`) constrain local distribution alongside existing component
allowlists. Imported foreign plugin settings remain under `plugins.pending` as
inactive source references until explicit review and installation.

### Embedding SDK

The package exports `createAgentSession` for Bun applications, with native tools/providers,
approvals, events, explicit recording/resume and session controls. Imports are inert; session
execution requires Bun >=1.3.14 on macOS/Linux. See the [SDK guide and runnable local examples](examples/sdk/README.md).

### Native background commands

Use `!command` in the native composer to execute through approvals and include its result in model
context. `!!command` excludes the command and output from model context while keeping it visible in
the local transcript. `/tasks` opens a live task/output view; Ctrl+B lets a foreground command continue
in the background. `/tasks stdin ID "hello\n"`, `resize ID COLS ROWS`, `output ID`, `kill ID` and
`wait any|all IDS` control the owned terminal. Closing the session stops its commands. A persisted task
record never resumes an old process. Background writes retain workspace mutation/checkpoint admission
until they stop; use the model's `exec_command` readOnly option for enforced read-only concurrency.

Shell state is explicit: `codesplash shell-state capture SNAPSHOT --shell bash --env LANG
--definitions DEFINITIONS` imports selected environment values and alias/function source without
executing startup files. Review with `shell-state review SNAPSHOT`, then trust the exact
`--fingerprint HASH`. The native exec_command snapshot option and SDK runCommand accept that path
and fingerprint; changed files lose trust, credential/startup environment names are refused and
replay stays sandboxed. The snapshot must be in the session's authorized read roots.


### Native child agents

`agent` starts a fresh child session; `list_agents` lists definitions. The built-in `explore` and
`plan` roles enforce read-only access. `general` inherits the parent's available authority. Children
share bounded task admission with commands, and `task_output`, `task_wait`, `task_kill` and `/tasks`
handle their output and lifecycle. Child approvals include their origin; closing the parent stops its
children. Tokens and cost estimates include child work.

Definitions live in `.codesplash/agents/name.md`, the user `context/agents` directory, verified plugins,
or `[agents.definitions.NAME]` configuration. Names can be qualified as `project/name`, `user/name`,
`config/name`, `builtin/name` or `plugin/id/name`. Unqualified names prefer project, config, user, then
built-in definitions. Definition settings only narrow parent access. MCP defaults to none; select
`all`, `none`, `only:server-a,server-b` or `except:server-a` in Markdown. Configuration uses `mcp.only`
or `mcp.except` arrays. Tools use exact names; Markdown lists are comma-separated.

```sh
codesplash agents list --trust
codesplash agents create reviewer --write
codesplash agents show project/reviewer --trust
codesplash agents enable project/reviewer --fingerprint <reviewed-hash> --trust
```

Creation and import leave definitions disabled. Review the prompt, model and scope before enabling.
SDK `spawnAgent({ agent: "explore", prompt: "Inspect the parser", background: true })` returns an owned
task; use `tasks({ action: "wait", ids: [id], all: true, timeoutMs: 10000 })` to wait. `resume: id`
continues the same definition/persona/model/cwd identity; changed sources or authority refuse resume.
Recorded child transcripts survive parent restart; no-history children remain in memory. Uncertain
execution requires explicit `reviewUncertain: true` and a new prompt. It never resumes an old PID.

Each child defaults to 65,536 tokens and 120 seconds, narrowed by ancestor budgets. Output requests
reserve estimated input and bounded output before provider dispatch; unknown usage stops further
requests. Nested spawns at full capacity fail explicitly so parents cannot deadlock waiting for a slot.

Native orchestration also supports explicit context forks, owned Git worktrees and local peers.
Use `spawnAgent({ agent: "explore", prompt: "…", context: "fork", worktree: id })` for an independent
context snapshot in an existing owned worktree. `directive` adds bounded instructions. Resume and
`peers({ action: "followup", target, prompt })` preserve the recorded context and capability identity.
`send_message`, `wait_agent` and `interrupt_agent` operate the root's peer graph. Queued messages
arrive as attributed data at a provider boundary; an idle peer waits for an explicit followup.

```sh
codesplash worktree create HEAD --apply --trust
codesplash worktree list
codesplash worktree preview WORKTREE_ID
codesplash worktree apply WORKTREE_ID --fingerprint REVIEWED_HASH --apply --trust
codesplash worktree recover WORKTREE_ID
codesplash worktree rollback WORKTREE_ID --apply --trust
codesplash worktree remove WORKTREE_ID --apply --trust
codesplash worktree gc --apply --trust
```

Worktrees live in `.codesplash-worktrees/<id>` beneath the repository. Open a standalone native
session with `codesplash run --engine codesplash --path WORKTREE_PATH --trust`; it holds ownership until close.
SDK `worktrees()` exposes the same lifecycle. Creation lists excluded credential/configuration or
denied paths and marks those entries intentionally absent in Git's index. Host operations use raw
objects and guarded file writes without running repository hooks or filters. Per-file ask rules
remain separate: read-ask paths are omitted and write-ask paths cannot be applied through this control. Limits are 16 owned
trees, 5,000 tracked files, 64 MiB snapshots, 256 MiB per tree, and 128 changed files of at most 2 MiB
per apply. Symlink/submodule checkouts require separate manual isolation. Apply refuses diverged
files; source and recovery refs remain available. Interrupted replacement supports explicit
`rollback`, preserving concurrent external edits. Removal refuses active, dirty, ignored or hidden
content. Recovery refs are retained after removal.

For cross-session data, `peers({ action: "endpoint" })` exposes an explicitly approved private Unix
endpoint while its owner lives. Another session can use `send_message` with that endpoint. External
senders are labeled as capability holders; sender claims in payloads do not grant user authority.
CLI `codesplash peer listen --duration 60` opens a temporary data-only mailbox and prints its endpoint;
`codesplash peer send ENDPOINT root 'message'` sends to it. Endpoints authenticate each bounded
message, disappear on close, and never start provider work automatically. These local controls use
macOS/Linux facilities and do not require Docker. See SDK example 11 for a complete local flow.

Native goals and workflows use bounded, owned background tasks. `session.goals({action:"create",
objective,limits:{tokens,timeoutMs,rounds}})` records an explicit goal; `start` runs worker/verifier/
strategist rounds. `get`, `pause` and `resume` expose cumulative budgets and evidence. Verification
requires successful observed read-only tools; budget exhaustion and unknown usage pause work.
SDK persistence stores these journals with the session; the default ephemeral SDK keeps them in memory.

`codesplash workflows create NAME --write` creates a disabled JSON definition. Inspect with
`workflows show NAME`, then `workflows enable NAME --fingerprint SOURCE_SHA --apply` after reviewing
its exact source. Definitions contain prompt, command, verification and parallel-join steps with
explicit dependencies and token/time limits. `session.workflows` supports reviewed inline definitions
or saved names, listing, pause/resume, per-step review and forgetting inactive resolved runs. Successful
steps are skipped on resume; failed or uncertain effects require explicit review before another attempt.
Saved source, model, configuration and workspace identity are rechecked. Root task retention/capacity
limits can pause a run; inspecting/forgetting completed task records remains explicit.

`codesplash automation goal OBJECTIVE --tokens 200000 --timeout-ms 120000 --rounds 3 --apply --trust`
and `automation workflow NAME --fingerprint HASH --apply --trust` run finite local owners, recording
sessions for later `automation inspect SESSION` or `automation resume SESSION RECORD --apply --trust`.
Use `--store ROOT` to select the session store. Requests default to decline; `--approve` explicitly
approves requests for that bounded invocation. SDK responders or the interactive session can review
individual requests instead. Closing the owner stops work; persistence does not install a daemon.
`workflows import SOURCE --name NAME [--write]` previews/imports native JSON or a literal one-agent
Grok Rhai script as disabled work. Other Rhai constructs require manual translation and are never evaluated.

`session.schedules` provides create/list/enable/delete/review, start/stop of a finite worker, and an
explicit manual `run`. Schedules persist separately under the selected data directory; configured
history-disabled policy refuses scheduling. Creation is disabled by default. Review its fingerprint
before enabling, and explicitly start an owner to run future occurrences. Intervals range from one
minute to seven days; the supported UTC cron subset is `*/N * * * *` where N divides 60. Every schedule
has per-run token/time limits, an occurrence cap, a lifetime token ceiling and expiry. Missed intervals
coalesce into one occurrence. A private workspace lease prevents two owners from dispatching it.

Use `codesplash scheduler create SPEC.json --write`, `scheduler list`, and
`scheduler enable ID --fingerprint HASH --apply --trust`. `scheduler worker --duration-ms 3600000
--apply --trust` owns future occurrences for up to one hour; `scheduler run ID --apply --trust` explicitly
runs one occurrence now using the same budgets and journal. Requests default to decline; `--approve`
authorizes them for that invocation. `scheduler review OCCURRENCE --apply` acknowledges checked effects
before future enable; uncertain occurrences are never automatically replayed. `scheduler import
native|grok|claude SOURCE --budgets BUDGETS.json [--write]` translates supported recurring prompt semantics
as disabled work; unsupported calendar/owner settings require manual review.

`/loop 5m PROMPT` creates a reviewed recurring prompt with four occurrences, 65,536 tokens and two
minutes per occurrence, a 262,144-token lifetime ceiling, one-day expiry and a one-hour local owner.
`/loop list` shows status; `/loop stop` stops that owner. A schedule with `watch:"src"` waits for coalesced
file changes and its cadence. Hidden/dependency/credential and denied paths are excluded. Notifications
are suppressed while owned work is active and briefly after settlement to prevent feedback; external
edits during that window may require another edit or an explicit manual occurrence. Watch errors or
oversized batches pause the schedule for review. Closing the owner stops execution; no daemon is installed.

Named teams use the same native child sessions, task budgets and approval rules. `/teams` (or
`/dashboard`) shows live member status, inclusive usage, parent edges and output. Select a member
and press **R** to queue a data reply, **D** to explicitly dispatch/resume work, or **K** to interrupt.
Create a roster with `/teams create {"name":"review","members":[{"name":"reader","agent":"builtin/explore","role":"reviewer","prompt":"Inspect the workspace"}]}`.
`/teams coordinator review` persists a main-session mode restricted to orchestration tools;
`/teams coordinator off` leaves it. Delegated workers retain their original scoped permissions.

`/teams panes review` opens optional read-only tmux views on a private, task-owned server;
`/teams close-panes` closes them. Attach from another terminal with the displayed socket:
`tmux -S SOCKET attach`. These views do not own another agent session. Missing tmux leaves the
in-process dashboard available. Closing the owner stops its children and panes; reopening restores
rosters and topology without starting work. Teams are capped at eight per root and sixteen identities
per team, including nested delegates. Member usage includes descendants; root totals count it once.

For a finite recorded CLI owner, use `codesplash teams run roster.json --apply --trust --approve
--duration-ms 120000 [--panes] [--model ID] [--store ROOT]`. It dispatches each named member once and
exits when the work settles or the deadline is reached (maximum one hour). `--approve` authorizes
requests only for that invocation; omitting it declines requests. `codesplash teams inspect SESSION`
reads the durable roster. SDK `session.teams(...)` exposes the same controls; example 15 exercises
reply versus dispatch and stable member identity.

Owned task completion also appears in the normal event feed with bounded, sanitized output.
Model-visible task statuses are delivered as data at the next provider boundary; they never start
a turn automatically. Context-excluded commands remain excluded from those model notices.
The SDK includes sixteen runnable local examples; example 16 combines parallel team writes,
a workflow command and a scheduled child in one session. `codesplash agent` is an alias for `agents`.
