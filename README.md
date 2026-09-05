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

Resumed runs reuse the session's recorded sandbox and approval policy unless overridden on the
command line, and append to the same history (`--no-history` with resume is a usage error).

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

**Honest layering note**: this is a policy layer, not an OS sandbox. `bash` enforcement is
analysis + approvals — a command the analyzer cannot parse always asks instead of matching
rules — and
the write-path floors apply to the file tools, not to what an approved shell command does. The
OS-level sandbox for shell commands ships in a later milestone; until then, treat `allow` rules
for bash as trust statements about the commands they match.

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
