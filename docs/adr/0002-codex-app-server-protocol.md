# ADR 0002: Pin and isolate the Codex app-server protocol

**Status:** Accepted  
**Date:** 2026-08-15

## Context

The native Codex cockpit needs bidirectional operations that the high-level TypeScript SDK does not expose,
especially server-initiated approval requests and their responses. Codex app-server exposes those operations
over newline-delimited JSON-RPC, but the surface is still marked experimental and can change with the Codex
CLI.

Generating the protocol from an arbitrary installed CLI would make upgrades invisible. Handwritten provider
types would drift and could silently discard fields needed for resume, approvals, or diagnostics.

## Decision

Support Codex CLI `0.147.0` as the initial protocol baseline and check in its generated TypeScript bindings
under `src/engines/codex/generated/`.

The exact generator command is:

```sh
codex app-server generate-ts --out src/engines/codex/generated
```

The command intentionally omits `--experimental`: the app-server transport itself is experimental, but the
client opts out of additional experimental methods and fields during initialization.

All framing, request correlation, timeouts, notification ordering, server-request responses, line bounds,
and child-process lifetime behavior live behind `src/engines/codex/`. Application core and TUI code consume
normalized events and never import generated provider types directly.

## Consequences

- Protocol changes are reviewable source changes rather than hidden runtime drift.
- The generated snapshot is large (642 files for 0.147.0), so formatting excludes it while TypeScript still
  validates imports used by the adapter.
- Upgrading Codex requires regenerating the directory, reviewing the diff, updating contract fixtures, and
  rerunning the real app-server smoke check.
- Offline tests use an in-process transport and a fake child app-server; they do not consume model quota.
- The CLI exposes `--codex-smoke`, which initializes the installed app-server and reads account state without
  starting a model turn.

## Fallback

If the pinned app-server surface fails the Milestone 0 approval, interrupt, or resume gates, use
`@openai/codex-sdk` for a reduced-capability alpha. Do not show interactive approval controls unless the
active transport can answer the corresponding server request.
