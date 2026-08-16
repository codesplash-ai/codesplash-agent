# CodeSplash Agent

**Your entire dev workday. One terminal.** A terminal cockpit that drives the AI coding agents you
already pay for — OpenAI Codex natively, Claude Code through its official CLI — with your
credentials staying exactly where they are.

- **Codex, native.** Streamed responses, tool activity, live diffs, plans, interactive approvals,
  interrupt, crash recovery, and resumable sessions over the official `codex app-server` protocol.
- **Claude Code, official.** One keypress hands your real terminal to the official `claude` CLI and
  restores the cockpit when you leave. The app never reimplements or touches Anthropic auth.
- **Credentials stay on your machine.** The agent never reads, copies, proxies, or stores provider
  credentials. It launches the official CLIs you installed and lets them own their own auth.
- **Durable sessions.** Conversations persist locally (coalesced events, `0600` permissions, no raw
  provider payloads) and resume across restarts — or run with `--no-history` and write nothing.

## Install

Prerequisites: the agent is a cockpit, not the engines. Install and log in to the official CLIs you
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
[Releases](https://github.com/codesplash-ai/codesplash-agent/releases), verify it, and put `agent`
on your PATH:

```sh
shasum -a 256 -c agent-<version>-<os>-<arch>.tar.gz.sha256
tar -xzf agent-<version>-<os>-<arch>.tar.gz
mv agent /usr/local/bin/
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
agent [path]              # open the cockpit in a project (defaults to cwd)
agent --doctor            # non-interactive diagnostics: runtime, engines, auth, paths
agent --no-history        # write no session files this run
agent --sandbox read-only # override the Codex sandbox (read-only | workspace-write)
agent --full-access       # run Codex without a sandbox (requires typed confirmation)
```

Inside a session: `/help` (or F1) shows every key binding and command — `/new`, `/resume`,
`/engine`, `/model`, `/permissions`, `/history`, `/quit`.

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
