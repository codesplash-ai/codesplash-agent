# ADR 0003: Use Claude terminal handoff and per-platform Bun executables

**Status:** Accepted  
**Date:** 2026-08-15

## Context

Claude Code subscription authentication must remain inside Anthropic's official interactive CLI. CodeSplash
Agent therefore needs either to give that CLI the user's real terminal or to embed a complete child terminal
inside OpenTUI.

Embedding is more than spawning a process. It requires a pseudoterminal, VT/ANSI parsing and terminal state,
input translation, resize and paste handling, a cell-grid bridge into OpenTUI, and native packaging on every
supported platform. Milestone 0 tested those boundaries before making them part of v1.

## Evidence

The real-terminal implementation:

- destroys the OpenTUI renderer before launch and recreates it after the child exits;
- attaches the official `claude` process directly to inherited stdin, stdout, and stderr;
- forwards `SIGINT`, `SIGTERM`, and `SIGHUP`;
- snapshots terminal modes with `stty -g` and restores them in a `finally` block;
- resets style, cursor visibility, mouse tracking, bracketed paste, and the alternate screen;
- passed automated normal-exit, `SIGINT`, forced-termination, and signal-listener-cleanup tests; and
- passed a real, quota-free handoff to installed Claude Code `2.1.228` using `--version`.

The temporary embedded-terminal spike used Bun `1.3.14` on macOS arm64 with `node-pty` `1.1.0` and
`@xterm/headless` `6.0.0`:

1. Bun installed `node-pty` without running its untrusted native postinstall, leaving the packaged
   `spawn-helper` non-executable and causing `posix_spawnp failed`.
2. After manually restoring the helper's executable bit, `node-pty` could report child exit under Bun but
   emitted no PTY data, even for a shell that printed output and remained alive for one second.
3. The same installed `node-pty` package emitted the expected output under Node `26.5.0`, isolating the
   failure to the Bun/native integration rather than the shell fixture.
4. `@xterm/headless` independently parsed cursor movement and maintained the expected grid under Bun, so the
   JavaScript VT emulator was not the failed boundary.

`libghostty-vt` is a stronger future VT-state candidate than xterm.js because it is extracted from Ghostty's
tested terminal core and supports C, Zig, and WebAssembly. It is not a replacement for the failed PTY layer,
does not render into OpenTUI, has no official TypeScript/Bun binding, and does not yet have a tagged stable API.

The packaging spike also produced:

- emitted JavaScript that passed `bun dist/cli.js --help`; and
- a 70 MB macOS arm64 executable from `bun build src/cli.ts --compile` that passed `--help`, opened the
  production OpenTUI homescreen, and restored the terminal on quit.

## Decision

Use the official Claude CLI through full real-terminal handoff for v1. Do not add `node-pty`, xterm.js, or
`libghostty-vt` to production dependencies.

Use per-platform Bun-compiled executables for internal alpha builds, beginning with the proven macOS arm64
artifact. Do not promise a public cross-platform binary matrix until Milestone 5 runs build and smoke tests on
each target.

## Consequences

- Claude Code preserves its native login, permissions, slash commands, rendering, and resume behavior.
- Returning from Claude recreates the CodeSplash homescreen rather than preserving in-memory TUI component
  state; durable application state must live outside the renderer.
- Claude does not appear inside a CodeSplash transcript in v1.
- The production dependency graph avoids a failed native PTY binding and a second terminal renderer.
- Internal macOS alpha builds may be distributed as one executable, but the CLI still expects official
  `codex` and `claude` binaries to be installed separately.

## Revisit triggers

Reopen embedded terminal work only when all of the following are true:

1. a Bun-compatible PTY layer passes output, input, resize, signal, and forced-exit tests on every target;
2. embedding Claude materially improves the product beyond the reliable handoff;
3. a `libghostty-vt` C/WASM or other emulator binding has a supportable versioning and packaging story; and
4. the OpenTUI cell-grid bridge passes alternate-screen, color, Unicode, mouse, clipboard, bracketed-paste,
   and resize fixtures.
