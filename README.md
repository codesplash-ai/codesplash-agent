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
Skill instructions grant no permissions. `context: fork` is recognized but requires the future
subagent milestone. `/create-skill name` previews a scaffold; adding `--write` creates it.

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
or activates MCP. General settings/session migration and forked execution remain later work.
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
