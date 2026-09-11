# M6 A — configuration and runtime ownership

Status: binding implementation design, 2026-09-10. Full M6 delivery and acceptance
remain tracked in `docs/private/m6-plan.md`. This file defines tranche A; it does
not claim that later extensibility features are implemented.

## Resolution

Keep schema version 1 and existing user `config.toml` and `-c` syntax. Resolution
is defaults → user → trusted canonical workspace `.codesplash/config.toml` →
selected profile → allowlisted environment → CLI. A project file outside the
canonical workspace, including a symlinked `.codesplash` directory, is refused.
An untrusted project layer is reported as disabled and is never parsed/expanded.
No search through parent workspaces. Reads create no persistent state.

`[profiles.NAME]` contains ordinary settings and optional `extends = "NAME"`.
Profiles merge by name across active user/project sources. Selection is explicit
`--profile`, then `CODESPLASH_PROFILE`, then top-level `profile`. Resolve inheritance
oldest first, reject missing parents/cycles, cap at 32 profiles and 16 inheritance
levels. Project profiles have the same trust requirement as the project layer.
Scalars and arrays replace; tables merge recursively. Permission `deny` and `ask`
lists accumulate across layers; `allow` replaces. An empty array clears ordinary
arrays but cannot clear accumulated restrictions. TOML has no null/deletion
operator: remove a field at its original source to restore inheritance.

Environment overlay is deliberately small: `CODESPLASH_THEME`,
`CODESPLASH_MODEL`, `CODESPLASH_HISTORY`, `CODESPLASH_PERMISSION_MODE`.
Values pass the normal validator; no arbitrary environment import/interpolation.
Paths, credential values and executable settings are not expanded. Later tranche
schemas may add explicit environment references with separate validation.

`CODESPLASH_CONFIG` also accepts up to 64 KiB of JSON or TOML containing only
`theme`, `models.codesplash`, `history.enabled`, and `permissions.mode`. The individual
environment variables override that inline overlay.

Each source records scope, canonical path, SHA-256 of its bytes and disabled
reason. Per-field provenance records all contributing layers, including shadowed
values, without exposing their values. Explain output redacts sensitive strings.
Resolution metadata accompanies the effective config in a separate optional field
and is never persisted. A source fingerprint is identity, not executable trust.
Project trust never grants automatic execution of hooks/extensions/plugins.

## Local managed constraints

Read `managed.toml` next to the user config as a separate local policy ceiling.
This is local policy for the harness, not protection from someone who can edit
that file or run arbitrary code as the same OS user. Ordinary config cannot
select a different managed source or modify constraints.

Supported constraints: `sandboxModes`, `permissionModes`, `deny`, `allowedHosts`,
`environment`, and `required` ordinary settings. Unknown constraint fields fail
closed. Required settings are applied after ordinary layers and reported as
managed contributions. Mode constraints are checked again after per-invocation
flags, on runtime mode changes and on resumed/cwd runtime preparation. Network
and environment lists intersect requested grants; they never add privileges.
Managed deny rules join the existing deny-first permission pipeline.

## Validation and writes

Publish a JSON schema for raw TOML settings, profiles and managed policy. Existing
validators remain authoritative for semantic checks. `--strict-config` rejects
unknown fields in every active layer/profile; normal mode reports diagnostics for
forward compatibility. Prototype keys are always invalid. Config input is bounded
to 1 MiB, 32 levels, 20,000 nodes and 128 CLI overrides.

User edits use a raw-source read/modify/write operation with an expected hash,
exclusive local writer lease, private atomic replacement and a private backup.
Reparse and verify semantic roundtrip before publication. Preserve unknown tables
and profile definitions; refuse unsupported TOML values instead of dropping them.
Formatting/comments may change; original bytes are retained in the backup.
Theme/permission edits must never serialize an effective merged configuration.

## Runtime transition contract

Resolve against the actual runtime cwd, including headless, maintenance, resume,
review and prompt-debug paths. Runtime preparation captures the source generation;
cwd publication rechecks it, prepares new resources before replacing the old
runtime, and preserves the recorded sandbox pin. Theme is live-safe; existing permission edits re-resolve active rules at idle. Other config
changes activate only at an idle runtime transition/new session. Resource owners
carry source identity and generation; stale registrations are rejected. Disabled
features allocate no subprocess, connection or persistent feature state.

The existing permission/checkpoint/sandbox pipeline remains authoritative. Future
tool input rewrites run before final read-only classification and permissions;
hidden intrinsics cannot be overridden. External effects are not local checkpoint
effects. Owned resource disposal must settle before generation replacement.

## Probe decisions and acceptance

Private disposable probes use Bun 1.3.14, MCP client 2.0.0 and Ajv 8.20.0. A real
fixture initialize/list/call and offline validation pass in source, built JS and
compiled execution on macOS and Linux. The installed SDK reports protocol 2025-11-25; do not infer
support from website version labels. External TS package imports fail under
compiled Bun; importing a separately bundled extension works. D/E must bundle
dependencies before activation and verify the installed artifact hash. Protected
storage availability is probed per host; B must visibly refuse durable OAuth
storage when unavailable, never silently store plaintext. Linux probe evidence
and both platform acceptance gates remain required before tranche closure.

Acceptance covers precedence, inheritance/cycles, strict validation, hostile keys,
untrusted/symlinked projects, managed ceilings after flags, redaction, edit races,
unknown-field preservation and cwd/resume source changes, then complete native
suites and compiled configuration smoke on macOS/Linux.
