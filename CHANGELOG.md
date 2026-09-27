# Changelog

## Unreleased

## 0.2.0 — 2026-09-27

This feature release delivers the native-agent roadmap through M11 and the documented follow-up work. See [the release handoff](docs/roadmap-release-handoff-2026-09-27.md) for completed capabilities, remaining engineering, acceptance limits and deployment instructions. Windows remains experimental; Android, KVM and live-service/device acceptance are not promoted by publication.

### Release validation fixes

- Detect local APFS/HFS storage by mount identity on both macOS architectures.
- Correct Windows native handle cleanup, access masks, directory pinning and relative rename/link calls.
- Keep Windows sandbox broker provisioning state separate from the workload environment.
- Wait for actual terminal readiness in integration tests and include current guides in the distribution image.
- Retain the Windows protected-system-directory ACL refusal as an explicit experimental limitation.

### Additional original-roadmap implementation

- Add reusable prepared worktree pools, model-assisted disabled agent drafts and named persona defaults/overrides.
- Add paginated child transcript inspection, owned launchd/systemd scheduler service lifecycle and bounded Unix stdio relay.
- Include current feature guides in the offline docs site and render safe links, tables, lists and code.

### Original roadmap carryovers after M11

- Add seeded/piped interactive launch, scoped resume selectors and literal file/image arguments.
- Add opt-in early read-tool dispatch, explicit 413 image adaptation, partial-output fallback,
  exact streamed-loop detection and bounded empty-response recovery.
- Add model-family prompts, Anthropic cache policy/write accounting and native wire-cache diagnosis.
- Add exact semantic extension-tool versions, persistent reviewed workspace symbol/reference indexing,
  named startup timing and content-free Git/indexing categories.
- Add checksum-preserving ETag catalogs, inert metadata review artifacts, compatible discovery and
  reviewed single-executable runtime installation.
- Add registered-client browser PKCE with OS-store refresh/logout, search result domain filters,
  explicit Git sparse projection, three installed Git workflow SDK examples and Windows sleep code.
- Keep direct NFS/SMB live persistence, transparent kernel projection, Windows startup confinement/
  ARM64 storage and live-account acceptance explicitly open; see the roadmap status and release handoff.

### Distribution and enterprise controls (M11)

- Add signed standalone update staging/recovery/rollback, fleet policy and version ceilings,
  feature preferences, live kill switches and bounded announcements.
- Add explicit Bedrock, Vertex, Azure and OpenAI workload identities, Azure device login,
  OS credential storage, refresh serialization and tenant/provider restrictions.
- Apply shared offline, proxy, CA and timeout controls; preserve them through sandbox supervisors.
- Add custom kernel path denials, Linux cgroup resource limits and explicit startup hardening.
- Add build branding, helper aliases, key injection proxy, sandboxed terminal wrapping,
  disk accounting, offline docs/stats artifacts and a non-root CI image definition.
- Add package-manager update/recovery/rollback adapters, whole-agent startup filesystem isolation,
  a private supervisor bridge, and dedicated ephemeral QEMU micro-VM execution.
- Add an experimental Windows restricted-token/WFP backend, handle-relative NTFS transactions,
  job ownership, explicit setup commands, and administrator policy ACL validation.
- Retain experimental Windows/Termux status. Actual Windows/Android host gates,
  Windows startup isolation, and platform-specific package/terminal acceptance remain explicit limits.

### Observability, evaluation and advanced tools (M10)

- Add bounded content-free diagnostics, provider timing/retry records, crash recovery markers,
  trace summaries, reviewed feedback export/upload, and independently opt-in OTLP/analytics sinks.
- Add native behavioral evals with deterministic faults, explicit live-model budgets, optional
  advisory judges and suite-bound quality/cost comparison reports.
- Add Responses SSE/WebSocket transport, service tiers, checksum-pinned model caches and explicit
  local-runtime discovery/pull commands.
- Add image/PDF reads, notebook and anchor edits, confined code, clock, isolated browser actions,
  image/video job generation, plugin suggestions and reviewed local/container/SSH environments.
- Add checkpoint hunk review and conflict-safe rejection, explicit commit/PR attribution formatting,
  tool schema versions/presets, verified bundled search repair and bounded shell structure analysis.
- Keep advanced capabilities opt-in. External effects require approval and are never automatically
  replayed; live-provider, remote-host and platform validation limits are documented.

### Server, IDE and remote clients (M9)

- Add an authenticated native JSON-RPC daemon, generated protocol contracts, replay/snapshots,
  expiring shared/exclusive writer leases, browser client and simultaneous terminal attachment.
- Add ACP and MCP server adapters, a locally installable VS Code extension, fuzzy file pickers,
  terminal citation links, reviewed managed language services, diagnostics, symbol queries and formatters.
- Add opt-in sharing/revocation/URL import, TLS LAN listeners, optional mDNS and scoped TUI controls.
- Add GitHub App/OIDC and Slack Socket Mode workers, GitHub/GitLab CI recipes and isolated PR import;
  retain crash-uncertain delivery records to prevent repeated external effects.
- Add streamed headless input, final JSON schema validation/atomic output files, selected native agents,
  actual tool ceilings and cumulative estimated-dollar limits shared with the embedding SDK.
- Explore a daemon-backed desktop/deep-link prototype; defer signed desktop distribution explicitly.

### Terminal experience (M8)

- Add fuzzy command palette/completion, external draft editing, contextual hot-reloaded keybindings
  and optional Vim editing; adapt mouse/clipboard behavior to terminal capabilities.
- Add user themes, bounded Mermaid/math rendering, explicit image preview, thinking controls,
  transcript search and switchable native scrollback.
- Add focus-gated notifications, terminal titles, configurable status segments and reviewed
  status commands, motion controls, sleep inhibition and an optional terminal pet.
- Add tabbed settings with provenance, integration management, bundled docs/release notes,
  dismissible onboarding and contextual tips.
- Add bounded native side questions and opt-in prompt suggestions with usage accounting and
  foreground cancellation; side answers stay outside the main conversation. Expose SDK `sideQuery`.
- Add reviewed recorder/transcriber dictation with hold/toggle, diagnostics, cancellation and
  draft-conflict handling. Realtime audio remains exploratory, with no support claimed.

### Durable memory (CodeSplash native engine)

- Add `/remember`, `/memory` and `codesplash memory` for repository facts, reviewed candidates,
  edit/delete, explicit move linking, index repair and bounded extraction/consolidation.
- Store versioned Markdown behind atomic manifests with a rebuildable SQLite FTS5 index;
  add optional governed embeddings, hybrid ranking, duplicate reduction and bounded context injection.
- Add scoped memory/history tools and resumable session notes. Keep durable activity disabled
  under no-history/untrusted sessions; permit retrieval and ephemeral notes in read-only/plan mode.
- Keep automatic learning opt-in, cancellable and session-owned, with auxiliary usage accounting.
  Verify the CLI memory lifecycle with local scripted providers in compiled release smoke tests.

### Long-session context (CodeSplash native engine)

- Add automatic compaction, `/compact [instructions]`, bounded context-overflow recovery,
  and a pruning-only strategy. Summary calls have no tools, bounded requests/output/time,
  interruption support, and session cost accounting.
- Add `/context` with component estimates, observed input usage, output reserve, context
  epoch and prompt-prefix change reasons. Keep tool specifications in stable name order.
- Preserve compacted context across resume with atomic native transcript snapshots and
  recover fully after write failures. Visible event history remains intact.
- Retain large sanitized tool results in a bounded session store and retrieve pages through
  `read_tool_output`. Under `--no-history`, retention and compaction stay in memory.

### Native sandbox, scoped access, and secrets

- Enforce shell commands, descendants, and file tools with macOS Seatbelt or Linux
  bubblewrap/seccomp. Refuse unavailable backends without an unrestricted retry. Protect
  Git/harness metadata, block hardlink escapes and direct network access, and preserve the
  exact plan-file write exception. Terminate detached descendants on exit and cancellation.
- Pin native execution profiles across resume; add `codesplash sandbox -- CMD`, execution
  diagnostics, bounded sandbox event logs, and explicit turn/session resource grants through
  `request_permissions`. `--no-history` disables sandbox logs too.
- Add keyring-backed `codesplash secrets set|list|delete`, explicit per-command secret
  bindings, and streaming/file-output redaction before truncation and persistence.
- Add optional bounded guardian review (off by default), permission rule editing and conflict
  explanations. Explicit asks, denies, dangerous commands, and resource/secret approvals
  cannot be waived by guardian review or headless auto-answering.
- Package the verified Linux seccomp helper and its license; test real sandbox execution in
  macOS/Linux CI and compiled artifacts. Development runs use a private harness snapshot so
  this checkout remains editable. Windows native and whole-process isolation remain deferred.

### Permissions (CodeSplash native engine)

- Permission modes: `default`, `accept-edits` (workspace file edits run without asking), `plan`
  (read-only investigation with a reviewable plan in `.codesplash/plan.md` and intrinsic
  `enter_plan_mode`/`exit_plan_mode` tools), and `bypass` (no approvals — only via the new
  `--bypass-approvals` flag with a typed confirmation, never persisted, never headless).
  Shift+Tab cycles modes in a session; the status line shows PLAN / ACCEPT EDITS / BYPASS.
- Permission rules: `allow`/`ask`/`deny` lists of `tool` / `tool(pattern)` strings — bash
  command patterns, file-tool globs, `web_fetch` hostnames — in `[permissions]` in config.toml,
  in a trusted project's `.codesplash/permissions.toml`, and as repeatable syntax-checked
  `--allow`/`--ask`/`--deny` flags on the TUI, `run`, and `review`.
- Dangerous-command floor: `sudo`, `rm -rf`, `dd of=/dev/...`, forced `git push`,
  curl-pipe-to-shell, and similar shapes always ask, in every mode (bypass included), can never
  be remembered, and are always declined headlessly — even under `run --auto`. The floor looks
  through git global flags (`git -C . push --force`) and recurses into `bash -c '...'` strings;
  unanalyzable commands (substitution, backticks, opaque interpreter strings) get the same
  always-ask treatment since they could hide any floor shape. Headless declines name the
  command class on stderr.
- Symlink-aware rule matching: deny/ask rules and the built-in sensitive-read protection match
  the physical (realpath) target as well as the written path, and allow rules vouch only for
  what is physically touched — a symlink inside an allowed subtree cannot extend the rule to
  its target. `web_fetch` deny rules are re-checked on every redirect hop and see through
  trailing-dot hostnames (`evil.com.`).
- Remembered-grant hygiene: shell-interpreter patterns (`bash(bash *)`) are never derived, and
  a file grant whose parent directory would blanket `/`, a first-level directory, or the home
  directory is refused rather than persisted.
- Self-protection write floor in every mode and sandbox: the file tools refuse writes into
  `.git`, the harness config/data directories, `~/.ssh`, and `.codesplash/` (except
  `.codesplash/plan.md`). Built-in sensitive-read denials (`.env`, key files, `*.pem`, …) with
  explicit-allow overrides, honored by grep too.
- Workspace trust: the first interactive codesplash session in a folder asks before loading
  AGENTS.md/CLAUDE.md and project permission rules; decisions persist in the data directory.
  Headless runs proceed untrusted with one stderr notice; `run --trust` / `review --trust`
  persists trust without the prompt.
- Remembered grants: approvals can offer "Always allow (persists)", storing a derived rule per
  project (`<data>/permissions/<project>.toml`); the reworked `/permissions` overlay shows the
  merged rules with their sources (cli/project/user/grants/built-in) and deletes grants.
- `--permission-mode <plan|default|accept-edits>` on the TUI, `run`, and `review`;
  `[permissions].mode` in config.toml; recorded per session and reused on `--resume`/`--continue`
  (a recorded bypass degrades to default headless). `codesplash --doctor` gains a one-line
  permissions summary (mode, rule counts, workspace trust). Shell completions cover the flags.

### CodeSplash native engine

- First-party CodeSplash engine: sessions run in-process against the Anthropic/OpenAI APIs with
  your own API key (`codesplash login <provider>` stores one locally; env vars always win),
  streaming responses and reasoning, built-in tools (read/write/edit/glob/grep/bash/apply_patch/
  todo/ask_user), sandbox and approval enforcement, and the same TUI surface as Codex.
- Headless `codesplash run`: one prompt, one turn, exit codes for CI; output as streamed `text`,
  a single `json` result object, or `stream-json` event lines — now including the `sessionId` and
  an estimated cost in `usage`.
- `codesplash run --resume <id>` / `--continue`: recorded run sessions keep an engine-owned
  transcript (`transcript.jsonl` next to the event log) and can be picked back up headlessly —
  recorded policy is reused, native execution profiles reject conflicting overrides, history is appended in place, and
  `--no-history` with resume is a usage error. TUI codesplash sessions are resumable from the
  session picker (and Ctrl+R) the same way.
- Custom providers (BYOK): `[providers.<id>]` tables in config.toml serve extra models through
  the anthropic or openai wire protocol (e.g. a local Ollama) with per-model context/output/
  pricing settings; API keys stay in env vars and are refused inside config.toml. Optional
  `[codesplash].fallbackModel` retries a failed provider request once on a fallback model.
- Cost accounting: per-session cumulative token usage with an estimated cost from catalog
  pricing, in `usage.updated` events, the `/usage` overlay (labelled "estimated", "partial" when
  a model has no pricing), headless JSON output, and `codesplash stats`.
- Web tools: `web_fetch` (URL to markdown/text with a DNS-pinning SSRF guard, per-hop redirect
  validation, and a 5MB cap) and `web_search` (DuckDuckGo HTML results) — read-only,
  cache-backed, gated per host/search under untrusted approvals, and every result is wrapped in
  an explicit untrusted-content notice so fetched pages cannot pose as instructions.
- Doom-loop guard: a tool call repeated with identical input is answered synthetically on the
  third try and force-ends the turn on the fifth.
- New subcommands: `codesplash review` (git diff review — uncommitted, `--base <ref>`, or
  `--commit <sha>` — in one read-only headless turn), `codesplash stats [--days N] [--json]`
  (recorded usage per engine+model), `codesplash completions <shell>` (bash/zsh/fish/powershell),
  and `codesplash debug prompt` (the model-visible surface as JSON).
- Repeatable `-c/--config dotted.path=value` overrides on the TUI, `run`, `review`, and
  `debug prompt` — applied to that invocation's config load only, never written back.
- `/usage` slash command in the TUI: session tokens, context left, estimated cost, and the
  current model in one overlay.
- `--doctor` reports configured custom providers (key env var names only, never values) and the
  newest codesplash session's transcript state.

### Harness

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
