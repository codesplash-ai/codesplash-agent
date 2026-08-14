# AI Agent CLI Implementation Plan

**Status:** Proposed  
**Reviewed:** 2026-08-14  
**Source:** [`docs/agent-plan.md`](./agent-plan.md)

## 1. Recommended direction

Build a Codex-first OpenTUI application, then add Claude Code as an official-CLI terminal surface.

The first useful release should provide:

- a native Codex chat experience with streaming text, tool activity, diffs, approvals, interrupt, and resume;
- a Claude Code launcher that temporarily hands the terminal to the official interactive CLI, with embedded PTY rendering added only after a terminal-emulation spike succeeds;
- one application controller and view model, but provider-specific transports and capabilities;
- durable local session metadata without reading, copying, or owning provider credentials.

Do not put native Claude stream-JSON mode, custom tools, an MCP marketplace, subagents, SSH serving, or single-file cross-platform binaries on the v1 critical path.

## 2. Review of the source plan

### Keep

- The “two engines, one cockpit” product shape is sound.
- Codex-first sequencing is the lowest-risk route to a useful product.
- OpenTUI React is a good fit for the existing stack and now includes textarea, streaming Markdown, syntax highlighting, and diff renderables.
- Provider schemas must remain inside adapters.
- A de-risking spike should precede the full scaffold.
- Exact dependency pins and recorded protocol fixtures are necessary because OpenTUI and both CLIs change quickly.

### Change before implementation

1. **Use Codex app-server for the native cockpit, not only `@openai/codex-sdk`.** The TypeScript SDK provides `runStreamed()`, thread resume, item events, and usage, but it wraps `codex exec` and does not expose a response path for interactive approvals. The current app-server v2 protocol exposes `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, message deltas, diff updates, token updates, user-input requests, and approval requests/responses. It is experimental, so isolate its JSON-RPC transport and pin a supported Codex CLI version.

2. **Model a live session, not disconnected `start()` and `send()` calls.** A session owns a bidirectional command channel and one ordered event stream. Approval responses and interrupts must carry the native request, thread, turn, and item identifiers.

3. **Make normalization intentionally lossless.** Store a stable common envelope plus the provider event name and raw payload. A small union such as `text.delta | tool.request | turn.end` would discard plans, warnings, terminal interaction, compaction, rate-limit updates, and provider-specific state needed for debugging and future features.

4. **Treat PTY hosting as terminal emulation, not process spawning.** `node-pty` provides a pseudoterminal but does not interpret ANSI/VT sequences or maintain a screen buffer. OpenTUI does not currently provide a child-terminal emulator. Embedded Claude therefore requires a PTY, an emulator such as `@xterm/headless`, and an OpenTUI cell renderer. The reliable v1 fallback is to suspend OpenTUI, attach the official `claude` process to the real terminal, and restore the cockpit after it exits.

5. **Do not duplicate provider session stores.** Codex and Claude remain authoritative for resumable model context. The application stores its own session ID, provider-native session ID, project identity, display metadata, and normalized UI history. Branch/fork support maps to provider capabilities rather than pretending every engine has identical semantics.

6. **Separate usage from cost.** Codex subscription events report token usage but do not provide a meaningful per-turn dollar cost. The status UI should show tokens, quota/rate-limit information when available, and provider-reported estimated cost only when the provider supplies one.

7. **Move compiled binaries out of the MVP gate.** OpenTUI ships native components, and an embedded PTY adds another native dependency. Prove `bun build --compile` on every target before promising a five-platform single-binary release. Start with a Bun/npm package or platform archive.

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
apps/
  cli/
    src/main.ts
packages/
  core/
    src/engine.ts
    src/events.ts
    src/reducer.ts
    src/config.ts
    src/sessions.ts
  engine-codex/
    src/app-server-client.ts
    src/driver.ts
    src/normalize.ts
    src/generated/          # versioned app-server protocol types
  engine-claude/
    src/driver.ts
    src/handoff.ts
    src/pty.ts              # created only if the spike passes
  tui/
    src/app.tsx
    src/components/
    src/keymap.ts
    src/theme.ts
tests/
  fixtures/codex/
  fixtures/claude/
  integration/
docs/
  adr/
```

Use a Bun workspace, TypeScript strict mode, Biome, and Bun test. Pin the initial OpenTUI packages to the same exact release; the current reviewed release is `0.5.3` and requires React `>=19.2.0`. Require a tested Codex CLI range beginning with the reviewed `0.147.0` protocol, rather than assuming any installed version works.

## 6. Milestones

### Milestone 0 — Protocol and packaging spikes

**Goal:** retire architectural unknowns before building product UI.

Tasks:

1. Scaffold the Bun workspace and a minimal OpenTUI React screen using exact dependency pins.
2. Render synthetic streaming Markdown, a diff, a textarea, and an approval modal from recorded in-memory events.
3. Implement a disposable JSON-RPC client for `codex app-server --stdio`:
   - initialize and read capabilities/account state;
   - start one thread and turn;
   - observe message/tool/diff events;
   - exercise approval response and interrupt;
   - resume the thread after restarting the app-server process.
4. Generate and check in app-server TypeScript protocol types from the minimum supported Codex CLI. Record the generator command and version in an ADR.
5. Test Claude full-terminal handoff, terminal restoration on normal exit, `SIGINT`, and forced child termination.
6. Prototype embedded Claude with `node-pty` plus a headless VT emulator and a minimal cell-grid renderer. Do not connect it to a paid model during this test; use a shell fixture that emits cursor movement, colors, alternate-screen transitions, resize events, and bracketed paste.
7. Attempt a compiled build with OpenTUI and the selected process dependencies on macOS. Record whether bundling native libraries works; do not postpone this discovery to release week.

Exit gates:

- Codex approval and interrupt round trips work through app-server.
- OpenTUI can render the expected event rate without visible input lag.
- Terminal state is restored after every tested child-process exit path.
- The team chooses either `terminal-handoff` or `embedded-pty` as the Claude v1 surface based on measured fidelity.
- The distribution format for the first alpha is decided from an actual build result.

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

- A user can start a Codex thread, see streaming output and tool progress, approve or deny a request, interrupt the turn, and send a second turn.
- Provider payloads never reach React components.
- A crashed app-server produces a recoverable UI state rather than corrupting the terminal.

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

- A session resumes after app restart without replaying the user prompt.
- Truncated final JSONL lines recover cleanly.
- No credential content is written by the application.
- Dangerous modes are visually persistent, not one-time notices.

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

- Claude Code behaves exactly as it does in a normal terminal for login, permissions, slash commands, and resume.
- Exiting or crashing Claude always restores the parent terminal and cockpit.
- Switching engines cannot accidentally send a prompt to the wrong live process.

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

- **UI reconciler:** React.
- **Primary native engine:** Codex app-server v2, gated by the Milestone 0 spike.
- **Codex SDK role:** reduced-capability fallback and reference implementation, not the approval-capable primary transport.
- **Claude v1 mode:** official interactive CLI through terminal handoff; embedded PTY only if its spike passes.
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
- [Anthropic legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Claude Code programmatic/headless mode](https://code.claude.com/docs/en/headless)
- [OpenTUI repository and packages](https://github.com/anomalyco/opentui)
