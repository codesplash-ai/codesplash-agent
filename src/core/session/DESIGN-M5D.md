# M5 D — portable sessions, migration and working-directory transitions

Binding continuation of the approved full M5 plan after C's macOS/Linux and seven-smoke
acceptance. C is now user commit `b8a3575` (README follow-up `742ff07`). One integrator;
no commits/publication. E remains required after D acceptance.

## Inventory and implementation order

Reviewed A repository/control/leases, B queue/history, C branches/fork/checkpoints/recovery;
`commands/import.ts` (instruction resources only), config parsing/saving, headless resume,
SessionController and TUI reconnect/permission ownership. Native driver currently fixes cwd,
permissions, sandbox and memory at construction; changing a display label is insufficient.

Local reference readers: grok's `xai-grok-foreign-sessions` Codex rollout/SQLite and Claude
project JSONL readers use approved roots, bounded metadata and schema qualification. Reuse
those boundaries, not their implicit home scanning. Our generated Codex session protocol and
existing Claude terminal handoff remain owner adapters. Foreign schema support is structural
and fixture-specific; unknown versions/columns/records are reported, never guessed as native.

Order: portable envelope/validation/safe viewers → atomic import and CLI/live export → foreign
readers/owner handoff and settings mappings → cwd transition ownership/integration → adversarial
review → native platform suites and all eight compiled smokes → evidence. No source credentials
or real private vendor stores are needed for acceptance.

## Portable format

`codesplash-session`, version 1, is JSON with a SHA256 payload checksum. Payload carries source
engine/local identity/provenance, creation time, sanitized title, selected head, ordered UUID nodes
and deduplicated SHA256-addressed native message contexts. Current export keeps selected ancestry;
all export keeps displaced branches. Portable contexts are sanitized history, not a byte-identical
backup of signed provider internals. Exact local C snapshots remain the recovery authority.

Whitelist known envelope/node/message/block fields. Preserve structural IDs and complete historical
tool/result pairing. Baseline sanitize text and structured tool-input values, remove reasoning/
signature/opaque thinking blocks, and report omissions. Vendor sessions without exact native
context export their supported visible user/assistant evidence as labelled conversion. Never claim
that converted text is a resumable vendor thread. Provider errors/tool diagnostics remain data.

Default exports omit images and external tool-output files with explicit omission reports. Optional
embedded images are bounded and validated by MIME/signature/base64; no referenced path/URL is
followed. Sharing redaction additionally scrubs source paths and identities and omits images.
Limits: 64 MiB envelope, 1,000 nodes, 100,000 messages total per context, 16 MiB embedded images
per export, and existing native-context/retained-store caps. No archive extraction or path members.

Markdown is a reading format; HTML escapes all content inside an offline document with restrictive
CSP, no scripts, links, embedded remote media or network loads. JSON import is the only portable
restore parser. File output uses explicit destinations, private files and no clobber by default.

Import preview verifies size/schema/checksums/topology/pairing/assets and reports conversion and
omissions. Apply revalidates source bytes and destination; stages a complete new native session,
remaps every node/local ID, writes exact sanitized context plus normalized display evidence, then
publishes atomically. An import fingerprint prevents duplicate publication in the same destination.
Imported content never installs instruction resources, executes tools, restores permissions/trust,
resumes an input queue or schedules jobs. Imported usage is inherited, not new billable events.
An explicit later resume starts under current local trust and permission rules.

## Foreign sessions and settings

Discovery requires an explicit root/vendor. Bound directory depth, candidate count and bytes;
refuse symlinks, hardlinks, traversal and source paths escaping that root. Codex session_meta /
response_item JSONL and Claude user/assistant JSONL are version-qualified evidence readers.
SQLite discovery inspects expected tables/columns; copy stable database/WAL bytes into private
temporary storage before querying so source sidecars are not created or changed. A store that
cannot be snapshotted consistently reports busy/incomplete. Cursor conversion accepts exported
Markdown as a quoted historical document, without reconstructing native roles or execution state.
Cursor SQLite layouts remain inspectable by table metadata only.
Fixture tests must substantiate every advertised mapping before release.

`session foreign list|show|convert|resume` and `import sessions VENDOR ROOT` share these readers.
Owner resume constructs literal argv for installed Codex/Claude after explicit selection; unknown
sources and Cursor have conversion only. No silent metered call occurs during discovery/import.
No authentication, token or vendor directory copying.

`import settings VENDOR FILE` previews supported model/history/context settings plus a per-key
unsupported report, then applies only selected supported equivalents after current-file CAS.
Existing resource-import syntax remains unchanged. Permission/MCP/hooks/environment/credential
keys are reported without values and never become grants. Add a simple validated default-model
setting only where an engine launch actually consumes it; no M6 layered profile system.

## Working directory

`/pwd` reads effective execution cwd. `/cd PATH` previews an idle transition and asks for explicit
carry/clear context choice before apply; current tools, requests, queue dispatch and M4 maintenance
must be settled. Resolve destination/trust and prepare new permissions, sandbox pin and memory/
context inputs before publication. Scope new checkpoints and context nodes to the new cwd; prior
repository memory and scoped grants do not follow the transition. Queue entries remain paused
for explicit review under the destination's attachment rules.

Keep stable local session/storage identity. Commit a revisioned cwd-transition journal and effective
project association; never move arbitrary workspace files. Publish the replacement execution state
only after preparation succeeds, and preserve the prior usable session on preparation failure.
Interrupted publication must resolve from durable journal evidence before any prompt. Unsupported
vendor cwd changes use an explicit new-session/handoff flow. TUI and headless resume must use the
effective cwd while storage lookup still uses the original storage project identity.

Publication protocol: the idle native runtime cancels/settles its M4 learner, flushes events and
fences routed session/queue mutations. Preview revision hashes control revision, resolved destination
and trust. A prepared state overlays canonical controls while immutable context blobs and a separate
cwd profile are prepared under the existing lease. No destination workspace files are moved/written.
The replacement runtime gets new permission/context/memory objects, empty branch notes, no previous
CLI overrides or grants, and a paused queue whose retained entries require editing and reattachment.
Its current model and cumulative local usage are retained. Returning to the original cwd selects
the original checkpoint scope; other directories have independent hashed scopes under a shared quota.

One control CAS commits the new cwd/project association, selected boundary and `pending` publication
record. Only then is the old runtime closed and the stable event/queue/method router switched. The
native transcript is replaced and `pending` cleared before provider admission. On interruption the
committed boundary repairs the transcript before opening; a failed preparation never changes the
canonical selection. Immutable assets from failed preparation can be reclaimed by normal GC.
Cleanup/publication failures leave the committed runtime paused for reconnect, rather than pretending
that the old location is still selected. Close waits for any admitted directory preparation.

`session cd ID PATH` / `session pwd ID` use the same destination and runtime transition for inactive
sessions. CLI apply verifies the preview under the writer lease before opening its idle runtime;
opening may reconcile queue/base state, so it obtains a fresh internal revision without releasing
ownership. Headless and TUI resume select the effective cwd and resolve storage with the original id.
New explicit CLI rules on a later launch apply to its effective directory. Older-directory branch
rewind requires a directory transition first; a fork uses the selected boundary's directory.

Settings mappings frozen for this tranche: Codex TOML `model` → `models.codex`,
`history.persistence` (`none`/`save-all`) → the explicitly reported global `history.enabled`;
Claude JSON `model` → `models.claude`, `autoCompactEnabled` → native `codesplash.autoCompact`;
Cursor JSON `model` → `models.codesplash` only for a known native catalog selector. Unknown keys,
vendor thresholds, permission/MCP/hooks/environment/credentials remain reports without values.
These are fixture-qualified structural mappings, not claims to reproduce every vendor release.
Installed Codex/Claude help was checked for `codex resume ID --cd DIR` / `claude --resume ID`;
no authenticated owning-session handoff was invoked for acceptance.

## Acceptance

Portable current/all branch round trips; malicious schemas/checksums, duplicate import, absent or
invalid images, redaction without corrupt IDs, escaped offline HTML, output no-clobber, and leases.
Foreign fixtures cover each supported shape and live-WAL source-byte preservation; unknown layouts
are reported. Settings CAS/unsupported credentials and resource-import regressions. Cwd failure,
trust/grant/queue/context/memory/checkpoint invariants and crash recovery. Real rendered commands,
full macOS/Linux suites and compiled portability/cwd smoke retain all seven C smokes.
