# Changelog

## 0.1.0-alpha.1 — 2026-08-16

First internal alpha. Everything below is new.

### Codex (native)

- Native Codex sessions over the official `codex app-server --stdio` protocol (pinned CLI 0.147.0):
  streamed responses and reasoning, tool activity, live diffs, plans, token/context status, and
  interactive approvals with interrupt and crash recovery.
- Durable local sessions: coalesced JSONL event history plus atomic metadata (0600/0700
  permissions), a project-scoped resume picker, transcript replay, and reconciliation against the
  resumed provider thread. Torn log lines self-heal.
- Sandbox and approval policy surfaced end to end: `--sandbox`, config defaults, a typed
  confirmation for `--full-access` on every session open, and a persistent status-line badge.
- Model switching (`/model`) via the provider's model list, applied per turn; account rate-limit
  usage in the status line.

### Claude Code (official CLI)

- Real-terminal handoff to the official `claude` binary with guaranteed terminal restoration on
  exit, crash, or signal. The app never touches Anthropic authentication.
- Launch metadata with app-supplied session IDs (documented `--session-id`/`--resume` flags only),
  resumable from an engine-scoped picker. Terminal output is never recorded.

### Cockpit

- Slash commands (`/new /resume /engine /model /permissions /history /help /quit`), F1 keyboard
  help, permissions/history overlays, actionable error hints, small-terminal layout.
- First-run diagnostics on the welcome screen and non-interactive `agent --doctor`.
- Signal-safe lifecycle: SIGINT/SIGTERM cleanup, Ctrl+Z suspend/resume, orphaned child prevention,
  history opt-out (`--no-history`), credential redaction at source.

### Distribution

- Per-platform Bun-compiled executables with SHA-256 checksums; CI matrix across macOS
  (arm64/x64), Linux (x64/arm64), and experimental Windows x64; npm package and Homebrew tap
  publishing wired into the tagged-release workflow.
