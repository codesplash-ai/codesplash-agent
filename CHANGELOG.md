# Changelog

## Unreleased

- Composer image attachments: drop an image file onto the terminal (or paste its path) and it is
  sent to Codex as an image, replaced inline with an `[image: name]` marker. Supports quoted and
  backslash-escaped paths; files over 8MB stay as text with a warning.
- The Codex CLI version gate accepts newer releases: 0.147.0 remains the tested baseline, newer
  versions run with an "untested" notice in the probe detail, and only versions older than the
  minimum are refused. The welcome screen no longer blocks on every upstream patch release.
- The app-server handshake now reports the real app version instead of a hardcoded "0.0.0".
- Removed the unused `fork` capability flag from the engine contract (nothing implemented it).
- The Scoop bucket manifest is published by the release workflow (was hand-pinned and unwired).
- New PR/push CI workflow (`bun run check` + launch smokes) — previously only tags were tested.
- Releases now fail early when the version being tagged has no changelog section.
- Product terminology: the app is a "harness" in all copy, code, and docs.

## 0.1.4 — 2026-08-19

- npm publishing switched to OIDC trusted publishing (no token, automatic provenance), unblocking
  the 2FA-restricted token flow that kept earlier builds off npm.

## 0.1.3 — 2026-08-19

- First signed macOS release: Developer ID signing plus notarization in the release build, so
  browser downloads no longer hit Gatekeeper's "damaged" dialog. First release available on npm.
- CI trimmed to tagged releases only; `bun run check` remains the pre-version gate.

## 0.1.2 — 2026-08-19

- Dead tag: the macOS release job failed while importing the signing certificate. No artifacts
  and no npm package were published for this version.

## 0.1.1 — 2026-08-19

- Dead tag: first attempt at macOS Developer ID signing; the release job failed at certificate
  import. No artifacts and no npm package were published for this version.

## 0.1.0 — 2026-08-17

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

### Harness

- Slash commands (`/new /resume /engine /model /permissions /history /help /quit`), F1 keyboard
  help, permissions/history overlays, actionable error hints, small-terminal layout.
- First-run diagnostics on the welcome screen and non-interactive `agent --doctor`.
- Signal-safe lifecycle: SIGINT/SIGTERM cleanup, Ctrl+Z suspend/resume, orphaned child prevention,
  history opt-out (`--no-history`), credential redaction at source.

### Distribution

- Per-platform Bun-compiled executables with SHA-256 checksums; CI matrix across macOS
  (arm64/x64), Linux (x64/arm64), and experimental Windows x64; npm package and Homebrew tap
  publishing wired into the tagged-release workflow.
