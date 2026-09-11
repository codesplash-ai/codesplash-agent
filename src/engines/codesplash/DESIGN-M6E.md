# M6 E — plugin distribution and activation, API 1

Binding implementation design, 2026-09-11. D is locally accepted; E is not yet accepted.
Reference inspection: local Codex plugin/manifest.rs and cli/marketplace_cmd.rs (component locators,
source identity and explicit updates); OpenCode packages/opencode/src/plugin/install.ts and
packages/core/src/plugin.ts (configuration patching, scoped registration/retirement); Pi extension
loader (package-local resolution); Grok user guide 09-plugins (install/enable/trust separation).
Bun 1.3.14 is the execution target. Official install/lifecycle documentation:
https://bun.sh/docs/pm/cli/install and https://bun.sh/docs/pm/lifecycle. Actual fixtures, including
compiled consumers, decide acceptance. No additional package-manager dependency is selected.

## Package and storage contract

Exactly one codesplash-plugin.json at the package root: schemaVersion 1, API 1, id (lowercase,
32 characters), exact semantic version, description, and explicit component declarations. Skills
and commands use the existing fixed skills/NAME/SKILL.md and commands/NAME.md layout. Hook and
MCP declarations use native validated contracts with relative package paths; extension entries use
D's relative TS/JS entries. Component IDs are deterministically namespaced. Metadata for agents
is retained and reported inactive pending M7; LSP declarations produce an explicit unsupported
error. Unknown executable manifest keys, ambiguous manifests, links and traversal are rejected.
No manifest discovery imports modules or executes scripts.

[plugins.entries.ID] records immutable root, integrity, source and enabled (default false).
[plugins.marketplaces.ID] records a pinned marketplace snapshot. User/project scopes use A's
source-preserving atomic edits. Trusted project configuration is required for project activation.
A adds plugin contributions as separately fingerprinted sources; ordinary configuration cannot
silently collide with a package component. Managed plugin IDs, marketplace IDs and immutable pins
constrain installation and activation; existing MCP/hook/extension ceilings still apply.

Version trees are addressed by SHA-256 under the private plugin store. A version lock records
source, content files, resolved dependencies and script decisions. Stage on the same filesystem,
validate everything, then rename the immutable tree and atomically switch the selected config
pointer under a local lease. Interrupted/failed staging leaves the selected version unchanged.
Old versions are retained, including after remove, so live sessions never lose code/assets.
Rollback selects a retained validated version. Removal detaches configuration and reports that
credential/session state and retained versions remain separately owned.

## Acquisition and dependencies

Local directories, git:URL#full-commit and npm:NAME@exact-version are supported; no silent update.
Git fetch/archive disables hooks and submodules, verifies the resulting commit, uses a disposable
repository and bounded owned subprocesses. npm metadata/tarballs require SHA-512 integrity and
an explicit registry origin (HTTPS by default, explicit loopback fixture option). Marketplace
snapshots use the same local/Git acquisition and versioned inert JSON index with pinned entries.
A plugin selected as ID@MARKETPLACE resolves only through that accepted index.

Limits: 128 KiB manifests/indexes, 128 marketplace entries, 32 selected plugins, 4096 regular
files, 16 MiB/file, 128 MiB expanded package, 32 MiB compressed/archive input, 64 dependency
packages, 128 MiB aggregate registry replies, 120 seconds acquisition/dependency work. Reject
devices, hard/symbolic links, duplicate archive paths, absolute/traversal names and unsupported
archive extensions. Streaming decompression and descriptor reads enforce limits before publication.

Bun resolves npm dependency ranges through an owned local registry proxy that validates metadata,
rewrites only accepted tarballs, bounds requests/bytes, validates archives before handing them to
Bun, and rejects non-registry dependency specifiers. The subprocess has isolated configuration,
explicit registry, copy backend and --ignore-scripts; ambient user package-manager configuration
and credentials are not inherited. The generated lock and installed bytes become package identity.
No package lifecycle code runs at install. An explicit reviewed build command operates on a fresh
copy, requires the exact package fingerprint, has owned cancellation/time/output limits, and publishes
a new disabled immutable version; its in-process-equivalent host privileges are disclosed. Script
changes require new execution trust. Failed scripts never replace the selected version.

## Runtime and resources

Installed, enabled and executable-trusted are distinct states. B/C/D fingerprint review remains
the execution authority; package enable does not grant executable trust. Plugin resource roots
enter M4's catalog with package provenance, ordinary collisions/diagnostics and the same read,
import, template, context-budget and permission pipeline. Package integrity is rechecked on
admission and reads. Agent metadata is never an executable tool in M6.

Live /plugins status|reload is a single session-admitted transition. Hold foreground admission,
cancel maintenance, stage effective config/resources/extensions/hooks and MCP clients, validate
policy/trust/generations, then publish once. Failure closes staged owners and preserves the old
usable runtime. Queued inputs discover again after publication; approval/cache/context identities
are invalidated. Provider registration changes require a new session, as in D. Loaded generations
pin their selected immutable versions until reload/cwd replacement; source file mutation still
fails integrity checks. Close/interrupt during staging cannot publish. Retire old API owners and
clients without deleting their immutable version directories. No JavaScript hard-unload claim.

CLI: plugin install/list/show/enable/disable/remove/update/validate/rollback/build; marketplace
add/list/show/update/remove. Inspection is inert and reports origins, pins, components, scripts,
trust and inactive reasons. Settings migration adds disabled, reviewed source mappings and explicit
foreign-format incompatibilities; never installs code during import.

## Required acceptance

Disposable local, Git, registry and marketplace fixtures; dependency/scripts inertness and explicit
build trust; archive hostility, changed-source refusal, failed update/rollback; managed ceilings;
resource/CLI/TUI migration; reload failure, queue/approval/maintenance/cwd/close ownership; both
full platform checks and all accumulated compiled smokes plus plugin install/resource/reload.
Retain exact manifest/logs/archives and update private matrices only after those gates pass.

## Implementation review refinements

Plugin executable trust keys include immutable plugin provenance so reviewing a candidate does not
revoke an older version still owned by a live session. Ordinary B/C/D trust paths are unchanged.
Inert management resolution bypasses component materialization so damaged packages can be disabled
or repaired. Managed required plugin values are reapplied over session pins. Per-chunk accounting
bounds concurrent registry replies; resolved dependency locks replace transient proxy URLs with the
original reviewed origin and integrity. An aggregate staging watchdog and hard per-file process
limit supplement final file quotas; explicit trusted build code retains host privileges.

The release smoke tests compiled CLI management plus a separately compiled native session consumer
for live reload/resources/close. It does not claim the CLI binary exposes an embedding entry point.
The native session fixture additionally stages real loopback MCP and HTTP hooks, verifies failure
preserves old trusted code, excludes lifecycle replay and refuses reload during foreground approval.
