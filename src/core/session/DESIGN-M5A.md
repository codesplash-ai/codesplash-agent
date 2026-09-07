# M5 A — session repository, lifecycle and recovery (binding design)

Based on 45389ff and the approved docs/private/m5-plan.md. Fresh macOS baseline:
1,278 passes, 4,840 assertions, 73 files. One integrator; no commits/publication.
Order: common I/O and ownership → canonical state → projections → migration/compression →
consumer adapters and CLI/picker → review/fixes → both platform suites and compiled smoke.

## Authority and compatibility

Existing meta.json, events.jsonl and native transcript.jsonl remain canonical for their existing
fields/content. Add a versioned control manifest: control.json points to immutable control/<uuid>.json
containing revision, parent revision, operation id/type/time and state. State owns manual title,
archive/deletion, organization and later queue/branch data. It does not independently overwrite
provider metadata or event history. Readers overlay the control-owned fields; SQLite is derived.
A control mutation fsyncs the immutable record then atomically replaces/fsyncs control.json.
That replacement acknowledges the operation; projection failure cannot claim rollback.
Control records contain complete state plus operation provenance; index recovery never drops
queue/organization/head changes. Limits: 1 MiB control snapshot, 1,000 pending bounded records
per namespace; preserve ancestors referenced by branches, compact history only via maintenance.

Keep project/session ids and directories stable, validate each component before joining paths.
Metadata v1 remains readable; explicit migration writes v2 metadata after preserving v1 backup.
A committed control migration marker requires metadata v2, detecting subsequent legacy downgrade.
V1 programs cannot reopen v2 metadata. Already-running legacy writers must be closed before apply;
preview reports live/new leases and old running/waiting metadata. Refuse uncertain active legacy
migration rather than silently assuming an old process is dead. Explicit recovery marks stale
legacy sessions interrupted before migration. Control replacement is recoverable independently
of compatibility metadata writes: the marker records the prepared v2 metadata for recovery.

## I/O, ownership and maintenance

Private paths must be regular singly-linked files beneath canonical roots, no symlink components.
Use O_NOFOLLOW/O_NONBLOCK, bounded reads, exclusive temporary files, fsync and atomic replacement.
Session writer ownership is a separate lease {host,pid,nonce}, acquired before recording; same-host
dead PID leases may be reclaimed after inode identity checks. An empty per-lease SQLite database
holds an OS-backed exclusive transaction across acquisition and release, serializing stale-file
reclamation across processes. This lock database contains no canonical session state. Live or foreign-host leases refuse
mutation. Never reclaim a foreign lease by age. All maintenance takes the same exclusive lease;
recorder close releases its own lease after flushing. Operations use revision preconditions.
Filesystem detection: verified APFS/HFS/ext/tmpfs/overlay local volumes permit writes; network or
unknown storage uses TRUNCATE and host-specific derived DB paths, using a local derived cache if the source volume is unverified, with canonical mutation refused
until the user chooses local storage. This provides safe inspection, not verified shared multi-host
writes. No NFS claim without an actual mount test. A bounded busy timeout never resets a live DB.

SQLite tables: sessions (ids/metadata/applied revision), FTS (sanitized title/user/assistant text),
control (canonical state projection) and maintenance progress. FTS5 uses trigram tokenization for
literal substring matching. Before a canonical write, publish an immutable .changes intent naming
the session; keep intents while its writer is live. Reindex captures intents, publishes the verified
new generation, then removes only captured intents whose writer has settled and source still matches.
Warm queries reconcile remaining intents with the index, including newly created sessions; they
never scan every transcript. V1 records retain canonical fallback until migration. Reindex uses a source cursor and
transaction batches; startup/list uses metadata, not whole transcript scans. Query pages <=100,
query <=1,000 characters, total indexed excerpt content <=1 MiB per session. Truncation is reported.
On absent/corrupt index, read commands use bounded fallback/explicit repair; no silent durable
mutation on read-only/no-history paths. Canonical corruption preserves evidence and fails explicitly.

Cold logs use built-in node:zlib gzip, compiled-probed with maxOutputLength. Only inactive sessions
can compress; events/native transcript are each represented by a versioned manifest with file name,
SHA256 and byte length. Write/verify/fsync compressed bytes, switch manifest, retire plaintext.
Reads validate hashes and limits; materialize under lease before appending/resume. Bounded maximum
single representation 64 MiB, explicit refusal retains larger originals. Recovery handles both
representations without silently choosing a mismatched one. Gzip is storage, not archive/deletion.

## Public behavior and integration

Repository methods support filesystem and in-memory state. SessionStore/SessionHandle and existing
readSessionMeta/readSessionEvents remain compatibility adapters. Existing ids, event sequence and
usage survive migration. Recorder, CLI/TUI resume, stats/picker and memory evidence use adapters;
compression must not strand direct transcript readers.
CLI: session list/search/show/rename/archive/unarchive/delete/projects/section/move/reindex/migrate/
compress/recover; ids or unambiguous exact titles, project/engine/archive filters, --limit/--offset,
--json, --path. Destructive/migration/maintenance operations preview unless --apply. No implicit
provider-thread deletion. Rename/organization are reversible direct user actions. Only metadata
and sanctioned user/assistant text are searchable, sanitized before projection/output.
TUI picker exposes search, archived visibility, rename/archive and explicit delete preview; the
same repository service is the authority. No fake controls or independently mutated UI arrays.

Delete commits a content-free tombstone outside the deleted session before removing local content;
reindex/open/list honor it even if cleanup fails or an old process recreates files. Purge derived
SQLite rows and shared-content references; repository memories remain independent and deletion
reports that fact. Active ownership refuses delete/compress. Recovery reports unresolved approvals
and potentially executed work; no automatic provider/tool replay.

## Acceptance

Fresh baseline + interpreted/compiled FTS/gzip/journal probes; legacy CRUD/regression suite;
control crash/orphan/revision tests, live/dead/foreign leases, symlink/hardlink/path attacks;
index corruption/rebuild/search/organization; v1 migration preview/recovery/downgrade detection;
compression interrupted transitions/checksum/limits/resume; delete non-resurrection; memory and
stats readers; no-history/in-memory zero persistence. Both native suites, build and compiled
session smoke in addition to all four prior smokes. A acceptance precedes B implementation.
