# AI Agent CLI Implementation Plan

**Status:** Milestones 0–3 implemented — manual dogfood pending for 2–3, Milestone 4 next
**Reviewed:** 2026-08-15
**Progress updated:** 2026-08-16
**Source:** [`docs/agent-plan.md`](./agent-plan.md)

## 1. Recommended direction

Build a Codex-first OpenTUI application, then add Claude Code as an official-CLI terminal surface.

The first useful release should provide:

- a native Codex chat experience with streaming text, tool activity, diffs, approvals, interrupt, and resume;
- a Claude Code launcher that temporarily hands the terminal to the official interactive CLI; the Milestone 0
  embedded-terminal spike did not pass, so PTY embedding is not part of v1;
- one application controller and view model, but provider-specific transports and capabilities;
- durable local session metadata without reading, copying, or owning provider credentials.

Do not put native Claude stream-JSON mode, custom tools, an MCP marketplace, subagents, SSH serving, or single-file cross-platform binaries on the v1 critical path.

### Implementation progress

| Milestone | Status | Current result |
|---|---|---|
| 0 — Protocol and packaging spikes | **Complete** | Real Codex approval/interrupt/restart/resume/second-turn smoke passed; Claude terminal handoff and restoration passed; embedded PTY was rejected for v1; emitted and compiled macOS arm64 builds passed. |
| 1 — Core and Codex vertical slice | **Complete** | The production Codex TUI is live-dogfooded for streamed prompts, tool/diff activity, repeated turns, model/context status, and long-session navigation. Real app-server and integration coverage prove approvals, interrupt, resume, crash recovery, and redaction. |
| 2 — Durable sessions and safety | **Implemented** | Sessions persist as coalesced JSONL plus atomic metadata, resume through a project-scoped picker backed by `thread/resume` with reconciliation, and policy/`--no-history`/full-access/signal handling are in place with all four exit gates covered by offline tests. The manual dogfood checklist remains before calling the milestone closed. |
| 3 — Claude official-CLI surface | **Implemented** | Diagnostics-only probe, tested real-terminal handoff, and launch metadata: the app supplies its own session ID through the documented `--session-id` flag, resumes with `--resume` from an engine-scoped picker, and stores no terminal output. Manual dogfood of a real login/permissions/slash-command/resume pass remains. |
| 4 — Cockpit completion | Not started | Deferred until both engine surfaces are proven. |
| 5 — Alpha distribution | Not started | A macOS arm64 Bun-compiled executable passed the Milestone 0 smoke and is the internal-alpha format; release automation and the target matrix remain. |
| 6 — Optional native Claude/extensibility | Deferred | Requires a fresh authentication/product decision. |

Current Milestone 0 checklist:

- [x] Select Bun 1.3+ and record the single-package decision in ADR 0001.
- [x] Scaffold TypeScript, Biome, Bun tests, React, and exact OpenTUI dependencies.
- [x] Define provider-independent engine/event contracts and a pure reducer.
- [x] Add offline reducer tests and a synthetic Markdown/diff/approval fixture.
- [x] Emit a runnable development build and smoke-test the CLI help path.
- [x] Visually exercise the OpenTUI fixture and verify terminal restoration.
- [x] Implement the Codex app-server JSON-RPC transport and fixture tests.
- [x] Generate/version the supported Codex app-server protocol types.
- [x] Run a quota-free real smoke check for initialize and account state against Codex CLI 0.147.0.
- [x] Prove approval, interrupt, and resume wiring against a fake app-server child process.
- [x] Add the branded provider home screen, exact Ocean & Heat dark/light palettes, keyboard focus between provider rows and footer actions, and persisted theme switching.
- [x] Prove declined approval, interrupt, process restart/resume, and a post-resume second turn through the
      real Codex app-server.
- [x] Implement Claude full-terminal handoff with terminal restoration and test normal exit, `SIGINT`, forced
      termination, and the installed official CLI.
- [x] Run the embedded-terminal spike and reject it for v1 after the Bun/`node-pty` transport failed; retain
      `libghostty-vt` as the preferred emulator candidate if the feature is revisited.
- [x] Build and run both emitted JavaScript and a Bun-compiled macOS arm64 executable, including a real
      OpenTUI open/quit smoke.

### Milestone 0 completion checkpoint — 2026-08-15

The repository is ready for its Milestone 0 commit. The checkpoint contains:

- the Bun single-package scaffold, pinned OpenTUI React runtime, strict TypeScript, Biome, and Bun tests;
- the provider-independent engine/event contracts, reducer, and synthetic OpenTUI fixture;
- the Codex app-server process/JSON-RPC boundary, generated Codex 0.147.0 protocol types, normalizer,
  live-session driver, quota-free probe, offline integration tests, and a passing real approval, interrupt,
  restart/resume, and post-resume turn smoke;
- the Claude official-CLI driver, real-terminal handoff, signal forwarding, terminal-mode restoration, and
  automated normal-exit/`SIGINT`/forced-termination coverage;
- the production homescreen with live Codex and Claude diagnostics, keyboard navigation across the agent
  panel and footer, terminal restoration, and the CodeSplash terminal lockup;
- exact Ocean & Heat dark/light semantic palettes sourced from `codesplash-website/docs/BRAND.md`, terminal
  theme detection, an atomic persisted theme override in the platform config directory, responsive branding,
  and the approved agent/footer navigation;
- ADR 0003's evidence-based `terminal-handoff` decision and a successfully opened/quitted 70 MB Bun-compiled
  macOS arm64 executable.

The synthetic `--fixture` screen remains a development surface. Milestone 1 has a separate production
Codex screen and controller and is complete; Milestone 2 begins with durable session metadata and resume UX.

### Milestone 1 completion checkpoint — 2026-08-15

- [x] Make Enter on authenticated, protocol-compatible Codex open a native `CodexSession`.
- [x] Keep raw provider payloads inside the controller/adapter boundary and expose reduced view state to React.
- [x] Render normalized user/assistant messages, reasoning, tools, diffs, plans, usage, warnings, and errors.
- [x] Add the multiline composer (`Enter` send, `Shift+Enter` newline), approval modal, and `Esc` interrupt.
- [x] Add `agent [path]` working-directory validation plus Git branch/dirty-state diagnostics.
- [x] Gate the native screen on binary presence, authentication, and the pinned Codex `0.147.0` baseline.
- [x] Redact credential-shaped stderr and surface child crashes as recoverable, native-thread resume actions.
- [x] Cover approval, interrupt, normalized streaming output, a second turn, process crash, redaction, controller
      isolation, preflight, and a redacted protocol fixture in offline tests.
- [x] Open and close the production Codex screen against the installed app-server without a model turn and
      verify terminal restoration.
- [x] Polish the production conversation surface with stable streaming updates, a borderless transcript,
      an Enter-send multiline composer, theme-correct cursor/input colors, latest/section navigation, a
      toggleable conversation outline, and live model/context status.
- [x] Dogfood the authenticated production TUI through streamed prompts, tool and diff activity, repeated
      turns, long-output scrolling, outline navigation, composer editing, and light-theme visual refinement.
- [x] Prove approval decisions, interrupt, restart/resume, and a post-resume second turn against the real
      app-server, with the production controller/UI command paths covered by offline integration tests.

**Result:** complete and ready for the Milestone 1 commit. The core/UI boundary remains provider-independent;
raw Codex payloads stay inside the adapter; crashes recover without corrupting the terminal; and all automated
checks remain quota-free. The dogfood session supplied the production rendering/input acceptance that cannot be
meaningfully covered by the fake app-server alone.

### Milestone 2 implementation checkpoint — 2026-08-16

- [x] Split platform data from config paths (`dataDirectory()`, `CODESPLASH_AGENT_DATA_DIR` override) and grew
      the versioned config to `theme`, `[history].enabled`, and `[codex].sandbox`/`approvalPolicy`, written by an
      internal TOML serializer (Bun has no stringify; its parser also swaps the `\t`/`\f` short escapes, so the
      serializer emits `\uXXXX` forms) and validated with aggregated, actionable errors.
- [x] `danger-full-access` is rejected as a persisted config default; `--full-access` is the only route to it and
      re-confirms (typed `yes`) on every session open, resume included. The status line shows a permanent policy
      badge — `FULL ACCESS` on the destructive background in danger mode — and picker rows carry the same badge.
- [x] Session store at `sessions/<project-id>/<local-session-id>/meta.json` + `events.jsonl` (0700 dirs, 0600
      files, atomic metadata replacement). Project IDs are truncated SHA-256 of the canonical cwd.
- [x] `SessionRecorder` taps the controller ahead of reduction: per-token deltas are coalesced into completion
      events (one empty-text marker per item preserves live transcript ordering on replay), `raw` provider
      payloads are always stripped, lines are bounded at 256 KiB, and `reasoning.completed` gained an optional
      `text` payload so reasoning survives replay.
- [x] Torn final JSONL lines are dropped on read and healed by truncation before the next append; corrupt
      interior lines are skipped without discarding the intact history after them.
- [x] Project-scoped resume picker; replay folds the persisted log through the pure reducer into the controller's
      initial state, then attaches via `thread/resume` with `firstSequence` continuing the log monotonically.
      Provider turns missing locally are synthesized from `thread.turns` via the shared item normalizer
      (`knownTurnIds` suppresses duplicates); a dead provider thread falls back to a fresh `thread/start` with a
      persistent warning while keeping the replayed transcript. Ctrl+R reconnect now restores the transcript too.
- [x] Resume never silently escalates policy: the effective sandbox comes from config/flags, not from the stored
      session metadata, so a full-access session resumed without `--full-access` runs workspace-write.
- [x] CLI grew `--no-history` (recorder never constructed, nothing written), `--sandbox <mode>`, and
      `--full-access`, with flag > config > default precedence and unit-tested parsing; `cli.ts` main is guarded
      by `import.meta.main` so the parser is importable by tests.
- [x] App-level SIGINT/SIGTERM handlers run cleanups newest-first (renderer restore → controller close →
      recorder flush), a second signal skips straight to child SIGKILL, spawned app-servers are SIGKILLed by a
      synchronous exit handler if orphaned, signal exits are deferred while Claude handoff or `codex login` owns
      the terminal, and Ctrl+Z suspends the TUI to the shell with SIGCONT resume.

Exit-gate coverage (all quota-free): the resume round-trip integration test proves restart → `thread/resume`
with zero `turn/start` and a transcript identical to the live session; the store tests prove torn-line recovery
and healing; the history-safety tests crash the fake child mid-turn with credential-shaped stderr and assert no
secret substrings and no `raw` keys in `events.jsonl` or `meta.json`, plus that a no-recorder run creates
nothing under the data directory; the safety-indicator tests assert the full-access badge and confirmation
semantics in both palettes.

**Remaining before the milestone commit is closed — manual dogfood checklist:** resume a real authenticated
session after an app restart; Ctrl+Z then `fg` from welcome and from a live session; external SIGTERM mid-turn
restores the terminal and leaves a resumable "interrupted" session; resize during streaming; `--full-access`
confirmation, badge visibility across states, and Esc abort; `--no-history` leaves no session directory.

## 2. Review of the source plan

### Keep

- The “two engines, one cockpit” product shape is sound.
- Codex-first sequencing is the lowest-risk route to a useful product.
- OpenTUI React is a good fit for the existing stack and now includes textarea, streaming Markdown, syntax highlighting, and diff renderables.
- Provider schemas must remain inside adapters.
- A de-risking spike should precede the full scaffold.
- Exact dependency pins and recorded protocol fixtures are necessary because OpenTUI and both CLIs change quickly.

### Reference-source policy

This is an original CodeSplash implementation, but upstream source is the design reference rather than a
black-box dependency:

- Follow OpenTUI's Bun-first runtime, renderer lifecycle, React reconciler, and component patterns. Keep the
  application view-model outside OpenTUI so a 0.x rendering change stays local.
- Follow pi's separation between a live session, its ordered event stream, and its UI; its steering/follow-up
  queues and tree-shaped JSONL sessions are the reference when those milestones arrive.
- Preserve pi's bias toward a small core. Provider-specific protocol breadth stays in adapters and generated
  types rather than growing the shared event contract without a real consumer.
- Reimplement the ideas in this repository and cover them with local contract fixtures. Do not couple to
  undocumented source internals or copy an upstream package graph before this project needs it.

### Change before implementation

1. **Use Codex app-server for the native cockpit, not only `@openai/codex-sdk`.** The TypeScript SDK provides `runStreamed()`, thread resume, item events, and usage, but it wraps `codex exec` and does not expose a response path for interactive approvals. The current app-server v2 protocol exposes `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, message deltas, diff updates, token updates, user-input requests, and approval requests/responses. It is experimental, so isolate its JSON-RPC transport and pin a supported Codex CLI version.

2. **Model a live session, not disconnected `start()` and `send()` calls.** A session owns a bidirectional command channel and one ordered event stream. Approval responses and interrupts must carry the native request, thread, turn, and item identifiers.

3. **Make normalization intentionally lossless.** Store a stable common envelope plus the provider event name and raw payload. A small union such as `text.delta | tool.request | turn.end` would discard plans, warnings, terminal interaction, compaction, rate-limit updates, and provider-specific state needed for debugging and future features.

4. **Treat PTY hosting as terminal emulation, not process spawning.** `node-pty` provides a pseudoterminal but does not interpret ANSI/VT sequences or maintain a screen buffer. OpenTUI does not currently provide a child-terminal emulator. Embedded Claude therefore requires a PTY, an emulator such as `@xterm/headless`, and an OpenTUI cell renderer. The reliable v1 fallback is to suspend OpenTUI, attach the official `claude` process to the real terminal, and restore the cockpit after it exits.

5. **Do not duplicate provider session stores.** Codex and Claude remain authoritative for resumable model context. The application stores its own session ID, provider-native session ID, project identity, display metadata, and normalized UI history. Branch/fork support maps to provider capabilities rather than pretending every engine has identical semantics.

6. **Separate usage from cost.** Codex subscription events report token usage but do not provide a meaningful per-turn dollar cost. The status UI should show tokens, quota/rate-limit information when available, and provider-reported estimated cost only when the provider supplies one.

7. **Move compiled binaries out of the MVP gate.** OpenTUI ships native components, and an embedded PTY adds another native dependency. Prove the chosen packaging approach on every target before promising a five-platform single-binary release. Start with an npm package or platform archive.

8. **Revalidate Claude policy at release time.** Current Anthropic documentation distinguishes ordinary individual Claude Code/Agent SDK usage from developers shipping products and says product integrations should use API-key authentication. V1 should use the official interactive CLI for subscription access. Any native Agent SDK or stream-JSON mode belongs behind a separate policy/product decision and must never read or replay `~/.claude` credentials.

## 3. V1 scope

### Must ship

- `agent [path]` starts in the selected repository.
- First-run diagnostics detect Bun/runtime compatibility, `codex`, `claude`, auth status, Git repository state, and terminal capabilities.
- Codex can start and resume threads, stream output, display tool progress and diffs, request approval, accept or deny approval, interrupt a turn, and recover from a child-process failure.
- The TUI has a scrollable transcript, multiline composer, status bar, approval modal, engine/session picker, and keyboard help.
- Local session metadata survives restart and links back to provider-native session IDs.
- Claude Code can run through a safe full-terminal handoff and return cleanly to the cockpit.
- Config supports engine defaults, sandbox/approval policy, key bindings, theme, and history opt-out.
- Unit, protocol-contract, reducer, and child-process lifecycle tests run in CI without consuming model quota.

### Explicitly deferred

- Native Claude transcript rendering or Agent SDK integration.
- Embedded Claude PTY if the spike does not meet fidelity and packaging gates.
- A custom model/tool loop; Codex and Claude Code continue to own their agent loops.
- Cross-provider conversation migration.
- App-owned OAuth or credential storage.
- Custom MCP server, extension API, package marketplace, subagents, split-pane parallel sessions, SSH hosting, web UI, and auto-update.
- Branching and compaction beyond provider-native support.

## 4. Architecture

```text
CLI entrypoint
    |
    v
ApplicationController <---- ConfigStore / SessionIndex
    |
    +---- EngineDriver.openSession()
              |
              v
         EngineSession <---- commands: send, approve, interrupt, close
              |
              v
        ordered AgentEvent stream
              |
              v
          EventReducer ----> AppViewState ----> OpenTUI React
```

The application controller is the only layer allowed to coordinate engine state, persistence, and UI state. React components render `AppViewState` and dispatch commands; they do not parse vendor events or spawn processes.

### Core contracts

```ts
type EngineCapabilities = {
  nativeTranscript: boolean;
  approvals: boolean;
  interrupt: boolean;
  resume: boolean;
  fork: boolean;
  usage: "none" | "tokens" | "estimated-cost";
  surface: "native" | "terminal-handoff" | "embedded-pty";
};

interface EngineDriver {
  readonly id: "codex" | "claude";
  probe(): Promise<EngineProbe>;
  openSession(options: OpenSessionOptions): Promise<EngineSession>;
}

interface EngineSession {
  readonly localSessionId: string;
  readonly nativeSessionId?: string;
  readonly capabilities: EngineCapabilities;
  readonly events: AsyncIterable<AgentEvent>;
  send(input: UserInput): Promise<void>;
  resolveRequest(requestId: string, decision: EngineDecision): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
```

Every normalized event should include:

- `schemaVersion`, monotonically increasing `sequence`, and timestamp;
- engine and local session ID;
- native thread, turn, item, and request IDs when present;
- a common event kind used by the reducer;
- provider event name and raw payload for forward compatibility;
- sensitivity metadata so logs can omit or redact unsafe payloads.

Start with these common event families:

- session state;
- turn lifecycle;
- assistant message and reasoning deltas;
- item/tool lifecycle and output deltas;
- plan/todo updates;
- file diff updates;
- approval or user-input request lifecycle;
- usage/rate-limit updates;
- warning, recoverable error, and fatal error.

### Persistence

Use platform-appropriate config and data directories. Do not hard-code only `~/.config` on macOS and Windows.

For each local session, store:

```text
sessions/<project-id>/<local-session-id>/meta.json
sessions/<project-id>/<local-session-id>/events.jsonl
```

`meta.json` contains schema version, engine, native session ID, canonical project path/hash, title, timestamps, and last known status. `events.jsonl` is append-only and contains normalized, coalesced events; do not persist every token delta. Rebuild UI state by replaying it.

Use atomic metadata replacement, `0600` file permissions where supported, and a `--no-history` mode. Never store provider auth tokens. Do not record Claude PTY output by default because it may include secrets and does not map reliably to semantic events.

## 5. Proposed repository layout

```text
src/
  cli.tsx
  core/
    engine.ts
    events.ts
    reducer.ts
    config.ts
    sessions.ts
  engines/
    codex/
      app-server-client.ts
      driver.ts
      normalize.ts
      generated/           # versioned app-server protocol types
    claude/
      driver.ts
      handoff.ts
      pty.ts               # created only if the spike passes
  tui/
    app.tsx
    components/
    keymap.ts
    theme.ts
tests/
  core/
  fixtures/codex/
  fixtures/claude/
  integration/
docs/
  adr/
```

Use one Bun package, TypeScript strict mode, Biome, and Bun's test runner. Bun follows OpenTUI's primary
runtime path; portable APIs at core and engine boundaries keep the exception contained. Avoid
workspace/package boundaries until a second independently built application exists. Extract packages only
when ownership, release cadence, or reuse requires it. Pin the initial OpenTUI packages to the same exact
release; the current reviewed release is `0.5.3` and requires React `>=19.2.0`. Require a tested Codex CLI
range beginning with the reviewed `0.147.0` protocol, rather than assuming any installed version works.

## 6. Milestones

### Milestone 0 — Protocol and packaging spikes

**Goal:** retire architectural unknowns before building product UI.

Tasks:

1. Scaffold the single-package Bun project and a minimal OpenTUI React screen using exact dependency pins.
2. Render synthetic streaming Markdown, a diff, a textarea, and an approval modal from recorded in-memory events.
3. Implement a disposable JSON-RPC client for `codex app-server --stdio`:
   - initialize and read capabilities/account state;
   - start one thread and turn;
   - observe message/tool/diff events;
   - exercise approval response and interrupt;
   - resume the thread after restarting the app-server process.
4. Generate and check in app-server TypeScript protocol types from the minimum supported Codex CLI. Record the generator command and version in an ADR.
5. Test Claude full-terminal handoff, terminal restoration on normal exit, `SIGINT`, and forced child termination.
6. Prototype embedded Claude with a Bun-compatible PTY binding (test `node-pty` first), a headless VT
   emulator, and a minimal cell-grid renderer. Do not connect it to a paid model during this test; use a
   shell fixture that emits cursor movement, colors, alternate-screen transitions, resize events, and
   bracketed paste.
7. Build and run the emitted Bun application with OpenTUI and the selected process dependencies on macOS.
   Prototype Bun-compiled executables and platform archives separately; do not postpone native packaging
   discovery to release week.

Exit gates:

- [x] Codex approval and interrupt round trips work through app-server.
- [x] OpenTUI renders the synthetic event stream without visible input lag.
- [x] Terminal state is restored after every tested child-process exit path.
- [x] Claude v1 uses `terminal-handoff`. The embedded spike failed at the Bun/PTY transport boundary before a
      reliable cell renderer could be built; see ADR 0003.
- [x] The first internal alpha uses a Bun-compiled executable per platform. The macOS arm64 executable was
      built, opened the production OpenTUI homescreen, and restored the terminal on quit. Cross-platform
      release artifacts remain gated on the Milestone 5 target matrix.

**Result (2026-08-15): complete.** Codex CLI `0.147.0` passed initialize/account diagnostics and a live
declined-approval, interrupt, app-server restart/resume, and post-resume `RESUME_OK` turn. Claude Code
`2.1.228` passed the real-terminal `--version` handoff; fake-child tests cover normal exit, `SIGINT`, forced
termination, signal-listener cleanup, and restoration. The PTY spike used `node-pty` `1.1.0` and
`@xterm/headless` `6.0.0`; its evidence and the `libghostty-vt` revisit path are recorded in ADR 0003.

If app-server fails the stability gate, fall back to `@openai/codex-sdk` for a reduced alpha with `runStreamed()`, resume, abort-signal interrupt, and a non-interactive approval policy. Do not fake an approval UI that the transport cannot answer.

### Milestone 1 — Core and Codex vertical slice

**Goal:** complete one real prompt end to end before expanding the UI.

Tasks:

1. Implement the engine interfaces, event envelope, reducer, and capability checks.
2. Build a framed JSON-RPC stdio transport with:
   - request correlation and timeout handling;
   - ordered notifications;
   - server-initiated request responses;
   - malformed-line isolation;
   - stderr capture with redaction;
   - child exit and restart semantics.
3. Implement `CodexDriver` for thread start/resume, turn start, message/tool/diff normalization, approvals, interrupt, and close.
4. Build the minimum TUI: transcript, composer, status line, approval modal, and `Esc` interrupt.
5. Add preflight checks for binary presence, supported version, auth state, working directory, and Git status.
6. Add fake-process integration tests and redacted real-event fixtures.

Exit gates:

- [x] A user can start a Codex thread, see streaming output and tool progress, approve or deny a request,
      interrupt the turn, and send a second turn.
- [x] Provider payloads never reach React components.
- [x] A crashed app-server produces a recoverable UI state rather than corrupting the terminal.

**Result (2026-08-15): complete.** Production-TUI dogfooding covered authenticated streaming, tools, diffs,
repeated turns, input behavior, status data, scrolling, and outline navigation. Real app-server smoke coverage
proved declined approval, interrupt, restart/resume, and a post-resume turn; fake-process integration tests
cover both approval decisions plus the production controller paths without consuming quota in CI.

### Milestone 2 — Durable sessions and safety

**Goal:** make the Codex slice safe enough for daily use.

Tasks:

1. Implement platform data/config paths, versioned config validation, and actionable config errors.
2. Add local session metadata and coalesced event persistence.
3. Add a project-scoped resume picker backed by provider-native thread IDs.
4. Restore a transcript from the event log, then reconcile it with the resumed provider thread.
5. Surface sandbox and approval policy explicitly. Default to `workspace-write` plus interactive approval; require a deliberately loud flag and confirmation for full access.
6. Handle `SIGINT`, `SIGTERM`, terminal resize, suspend/resume, and orphaned child cleanup.
7. Add history opt-out and log redaction tests.

Exit gates:

- [x] A session resumes after app restart without replaying the user prompt (resume round-trip integration
      test: `thread/resume` observed, zero `turn/start`, transcript equality).
- [x] Truncated final JSONL lines recover cleanly (torn-line drop on read, truncation heal before append).
- [x] No credential content is written by the application (credential-stderr crash sweep over both files, `raw`
      never persisted, tokens never enter metadata, `--no-history` writes nothing).
- [x] Dangerous modes are visually persistent, not one-time notices (permanent status-line badge asserted in
      both palettes, picker badges, per-open typed confirmation).

### Milestone 3 — Claude official-CLI surface

**Goal:** make Claude Code reachable without owning its authentication or agent loop.

Tasks:

1. Implement `ClaudeDriver.probe()` using binary/version/auth diagnostics only.
2. Implement full-terminal handoff:
   - stop or suspend the OpenTUI renderer;
   - restore canonical terminal settings;
   - launch the official `claude` binary in the selected cwd with inherited stdio;
   - forward signals;
   - restore OpenTUI on exit.
3. Pass only documented CLI flags. Never read files under `~/.claude` and never copy OAuth tokens.
4. If Milestone 0 approved embedded PTY, add it as an alternate surface with focus, resize, clipboard/paste, mouse, alternate-screen, and color tests. Keep handoff as the fallback.
5. Store only launch metadata and an optional native Claude session ID supplied through documented CLI output; do not parse the visual TUI to infer semantic transcript events.

Exit gates:

- [x] Claude Code behaves exactly as it does in a normal terminal for login, permissions, slash commands, and
      resume: the handoff inherits stdio and passes at most one documented flag (`--session-id` on new launches,
      `--resume <id>` on resume). Real-terminal dogfood of that pass is on the manual checklist.
- [x] Exiting or crashing Claude always restores the parent terminal and cockpit (existing normal-exit,
      `SIGINT`, forced-termination, and abort coverage; restoration runs in a `finally`).
- [x] Switching engines cannot accidentally send a prompt to the wrong live process: session pickers are
      engine-scoped, the Codex controller is closed before control returns to the welcome loop, and the Claude
      handoff is synchronous — the cockpit never has two live engine processes accepting input.

### Milestone 3 implementation checkpoint — 2026-08-16

- [x] `ClaudeDriver.probe()` uses `claude --version` and `claude auth status --json` only; the Claude engine
      contains no home-directory access and never reads `~/.claude` or copies OAuth tokens.
- [x] Launch metadata (`engine: "claude"`) records into the shared session store: `SessionMeta.sandbox`/
      `approvalPolicy` became optional because Claude owns its permission model inside the official CLI; picker
      rows badge Claude sessions as "official CLI".
- [x] The native session ID is stronger than the plan required: instead of parsing documented CLI *output*, the
      app generates the UUID itself and passes it through the documented `--session-id` flag, so resume via
      `--resume <id>` needs no output parsing at all.
- [x] Launch status tracking: metadata reads "running" while Claude owns the terminal, then `closed` (exit 0) or
      `failed`; a killed cockpit leaves a resumable "interrupted" row. No `events.jsonl` is ever created for
      Claude launches — terminal output is never recorded.
- [x] `--no-history` skips all Claude session recording and launches the CLI bare.
- [x] Embedded PTY remains excluded per the Milestone 0 decision (ADR 0003).
- [x] Offline tests cover flag construction, metadata lifecycle across launch/resume/failure against a fake
      `claude` binary that records its argv, non-resumable metadata rejection, and picker badges/resumability.

**Remaining before the milestone commit is closed — manual dogfood checklist:** launch real Claude Code from
the cockpit, exercise login state, permissions prompts, a slash command, and `/quit`; relaunch and resume the
same session from the picker and confirm the conversation continues; confirm the cockpit and terminal restore
after exit and after killing Claude externally.

### Milestone 4 — Cockpit completion

**Goal:** turn the vertical slices into a coherent daily driver.

Tasks:

1. Add engine/model/session pickers with capability-aware controls.
2. Add OpenTUI Markdown, syntax theme, diff view, scrollback, copy, and keyboard-help overlay.
3. Show cwd, Git branch, engine, model, sandbox/permission mode, turn state, token usage, and rate-limit status when available.
4. Add `/new`, `/resume`, `/engine`, `/model`, `/permissions`, `/history`, and `/quit` commands.
5. Add small-terminal and screen-reader-friendly layouts.
6. Add error recovery for unsupported protocol versions, missing binaries, expired auth, quota exhaustion, and repository trust failures.

Exit gates:

- All important state is visible without opening logs.
- Every command is keyboard accessible and has a discoverable binding.
- The UI remains usable at 80x24 and after rapid resize.

### Milestone 5 — Alpha distribution

**Goal:** ship a supportable personal alpha before broadening scope.

Tasks:

1. Publish the first alpha as the packaging format proven in Milestone 0.
2. Add CI on macOS arm64/x64, Linux x64/arm64, and Windows x64 in that order; only advertise targets that pass real launch smoke tests.
3. Run fixture tests on every target and opt-in authenticated smoke tests on protected runners.
4. Produce checksums, a changelog, supported provider CLI version ranges, and rollback instructions.
5. Add a release checklist that revalidates Codex documentation, Anthropic authentication policy, package licenses, and protocol compatibility.

Exit gates:

- A clean machine can install, pass diagnostics, launch both surfaces, and uninstall without leaving application-owned credentials.
- Unsupported provider versions fail with an upgrade/downgrade instruction.
- Release artifacts are reproducible and checksummed.

### Milestone 6 — Optional native Claude mode and extensibility

This milestone requires a fresh product/authentication decision. For a distributable product, use the Claude Agent SDK with API-key or supported cloud-provider authentication. A personal stream-JSON experiment may be feature-gated, but must use the official binary's own authentication behavior and carry no promise that subscription usage or policy will remain unchanged.

Only after both native adapters are stable should the project add a shared local MCP server, skills discovery, slash-command extensions, or a public extension API.

## 7. Test strategy

- **Unit:** event normalization, reducer transitions, config validation, project hashing, log coalescing, redaction, and capability gating.
- **Protocol contract:** replay versioned Codex notifications and server requests, including unknown fields and unknown event names.
- **Process integration:** fake JSON-RPC and PTY children test partial lines, backpressure, stderr noise, timeouts, signal handling, and exit races.
- **TUI snapshot:** deterministic views for streaming text, tool output, approval, diff, error, narrow terminal, and restored session.
- **Manual authenticated smoke:** one read-only prompt, one approved write, one denied action, interrupt, resume, auth expiry, and quota error. Run only when explicitly enabled.
- **Release smoke:** install artifact, run `agent doctor`, open/quit the TUI, exercise Claude handoff with a non-model command where possible, and verify terminal restoration.

CI must never consume subscription or API quota by default.

## 8. Security and operational defaults

- Inherit provider authentication; do not proxy, export, or log it.
- Default Codex to workspace-scoped writes and interactive approvals.
- Never silently fall back to full access.
- Validate the cwd before loading project configuration, hooks, plugins, or MCP definitions.
- Treat prompts, tool arguments, command output, diffs, and transcripts as sensitive local data.
- Redact environment values and authorization-shaped strings from debug logs.
- Make raw provider-event logging opt-in and short-lived.
- Bound queues, line sizes, persisted event sizes, and child shutdown timeouts.
- Restore terminal modes in `finally` paths and signal handlers.

## 9. Schedule and critical path

For part-time work:

- Milestone 0: 3–5 focused days.
- Milestones 1–2: 2–3 weeks.
- Milestone 3 with terminal handoff: about 1 week.
- Milestone 3 with high-fidelity embedded PTY: add 1–2 weeks.
- Milestones 4–5: 2–3 weeks.

A realistic daily-driver alpha is therefore 5–7 weeks with Claude handoff, or 7–9 weeks with embedded Claude. A polished multi-platform v1 remains closer to 2–3 months. Protocol and native-packaging findings can move those estimates materially.

## 10. Decisions recorded for implementation

- **Runtime and package manager:** Bun 1.3+, following OpenTUI's primary runtime path. Other CodeSplash apps
  remain on Node; ADR 0001 records why this terminal application is the exception.
- **Repository shape:** one package with `src/core`, `src/engines`, and `src/tui`; introduce `apps/` or workspace packages only when a second independently built artifact exists.
- **UI reconciler:** React.
- **Primary native engine:** Codex app-server v2, gated by the Milestone 0 spike.
- **Codex SDK role:** reduced-capability fallback and reference implementation, not the approval-capable primary transport.
- **Claude v1 mode:** official interactive CLI through terminal handoff; the embedded PTY spike failed and is
  excluded from v1.
- **Claude native stream mode:** deferred pending product/authentication decision.
- **Persistence:** provider-native context plus app-owned metadata and coalesced JSONL UI history.
- **Initial distribution:** evidence-driven package/archive; compiled binaries are not assumed.
- **Will not build for v1:** custom agent loop, app-owned auth, subagents, marketplace, web UI, SSH, or multi-user service.

## 11. Definition of done for v1

V1 is complete when a clean supported machine can install the CLI, run diagnostics, open a repository, complete and interrupt approval-aware Codex turns, resume them after restart, launch and return from official Claude Code without terminal damage, inspect diffs and usage, opt out of history, and pass all offline CI and platform smoke tests.

## 12. Primary references reviewed

- [OpenAI Codex SDK](https://developers.openai.com/codex/sdk/)
- [OpenAI Codex authentication](https://developers.openai.com/codex/auth/)
- [Codex TypeScript SDK source](https://github.com/openai/codex/tree/main/sdk/typescript)
- [OpenTUI source and development guide](https://github.com/anomalyco/opentui)
- [pi agent loop source](https://github.com/earendil-works/pi/tree/main/packages/agent/src)
- [pi session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session.md)
- [Anthropic legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Claude Code programmatic/headless mode](https://code.claude.com/docs/en/headless)
- [OpenTUI repository and packages](https://github.com/anomalyco/opentui)
