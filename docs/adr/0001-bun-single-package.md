# ADR 0001: Use Bun and a single-package layout

**Status:** Accepted  
**Date:** 2026-08-15  
**Supersedes:** The short-lived Node/npm runtime choice made during the initial scaffold

## Context

The initial proposal selected Bun because OpenTUI documents and tests a Bun-first workflow. We briefly
changed the scaffold to Node/npm to match the other CodeSplash applications, while retaining a
single-package layout.

The Milestone 0 runtime spike changed that tradeoff. OpenTUI 0.5.3 runs directly on Bun. Its Node path
currently requires Node 26.1+ with `--experimental-ffi`, and a normal `agent` executable would need a
self-relaunch shim to add that flag before importing OpenTUI. That would make an experimental compatibility
path part of the application's architecture.

This application has one executable. V1 does not include a web app, server, or another independently
released artifact, so there is still no reason to add an `apps/` directory or npm workspace boundaries.

## Decision

Use Bun 1.3+ as the runtime, package manager, script runner, and test runner. Continue using TypeScript,
React, Biome, and the TypeScript compiler for static checks and emitted development builds.

Keep the project as one package:

```text
src/
  cli.tsx
  core/
  engines/
    codex/
    claude/
  tui/
tests/
docs/
```

Use standard Web and Node-compatible APIs at the core and engine boundaries when practical. Bun-specific
code belongs at runtime, process, packaging, or OpenTUI integration edges.

## Consequences

- OpenTUI uses its primary, non-experimental runtime path.
- The CLI has one lockfile (`bun.lock`) and one release unit.
- Bun's built-in test runner replaces Vitest, removing a development dependency.
- Other CodeSplash applications remain on Node; this repository documents Bun as a deliberate OpenTUI
  exception rather than a new organization-wide default.
- Initial distribution can be an npm package requiring Bun or a Bun-compiled platform executable. The
  executable path still has to pass the target-matrix spike before it is promised.
- Add `apps/` only when a second independently built application exists.
- Extract a directory into a package only when it needs independent reuse, ownership, testing, or release
  cadence.

## Revisit triggers

Re-evaluate the runtime if OpenTUI's stable Node support no longer requires experimental FFI, or if a second
CodeSplash application needs to reuse these modules from Node. Either change should be proven with a small
runtime and packaging spike before replacing Bun.
