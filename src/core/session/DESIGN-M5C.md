# M5 C — retained context, branches and file recovery

Binding continuation of the approved full M5 plan after B's macOS/Linux and compiled acceptance.
One integrator, no commits/publication. Implement retained context → private snapshots/restore →
engine contracts/adapters → CLI/TUI/navigation → adversarial review → both platform/compiled gates.
D and E remain required.

## Reviewed consumers and contracts

Native `transcript.ts` stores provider-native messages, including thinking/image/tool blocks;
compaction replaces that file, so visible event reconstruction is not exact history. Loop
`historyRevision`, `historySnapshot`, turn/persistence settlement and permission-admitted tool
execution are the boundaries to integrate. B's writer-owned SessionStateAccess is the authority;
extend that owned access with its canonical directory for immutable recovery assets. Memory state
has no directory and keeps graph/context in memory. Never infer ownership from a transcript path.

The inspected local OpenCode snapshot implementation uses private Git storage and literal/NUL
paths; adopt those mechanics but do not invoke user hooks/filters or assume dirty files are agent
changes. Bundled Codex `ThreadForkParams` explicitly has `lastTurnId`; use generated `thread/fork`
with the completed turn precondition. Deprecated rollback is not used. Protocol fixtures provide
local adapter evidence, not live authenticated vendor verification.

EngineSession gains branch inspection, fork, rewind preview/apply and checkpoint preview/restore/
recovery operations only where implemented. Claude handoff exposes none. Shared service modules
own canonical graph, fork copying and snapshot journals; adapters own provider context changes.
All foreground operations reserve ownership, pause queued inputs and cancel/settle M4 learning.
Head changes reset approval/input/memory caches. Plain file restore never claims to undo external
process/API/network effects.

## Context graph and local forks

Use immutable UUID context nodes, parent ids and a selected head in `values.branches`. Each node
carries kind, timestamp, label, completed native turn id where available, normalized event boundary,
usage snapshot and a SHA256 reference to its provider-native context. Immutable contexts live under
`branches/` in the owned session directory. Bound a context to 64 MiB, retained contexts to 512 MiB
and graph metadata to 1,000 nodes; refuse overflow before acknowledging a new branch operation.
Deduplicate identical context blobs. Validate message/block structure and complete tool/result
pairing before advertising a selectable boundary. Keep images/thinking blocks byte-identical.

Capture native base/current context on first M5 C open, after complete turns and immediately before
and after compaction. An interrupted partial exchange is not selectable. Mutation checkpoints may
be taken mid-turn, but those are file-only targets until a complete provider context boundary exists.
Pre-M5 history lost to compaction stays unavailable; do not advertise invented historical nodes.

Rewind selects an existing node without erasing descendants and atomically persists the selected
context before another prompt can dispatch. Retain a prepared head-switch journal so a crash between
transcript replacement and control publication is detectable and finishable. New turns parent the
selected head. UI tree shows ancestry, current selection and explicitly unavailable boundaries.
Esc-Esc opens a backtrack preview and restores the prior typed prompt as a draft only after an
explicit selection; it never submits or changes files automatically.

Fork creates a fresh local id and metadata with origin provenance. Copy selected visible evidence
with a new event sequence/local id and exact selected context/assets. Do not copy approvals, grants,
trust, active queue, jobs or writable policy pins. Session notes inherit explicitly with provenance;
repository memories remain independent. Imported historical usage is labelled inherited and omitted
from new billable usage events, so global stats do not charge the parent twice. Native forks can
resume independently; Codex forks retain distinct provider thread ids. Codex rewind forks and
switches the active provider thread, retaining the displaced thread/node in the tree.

## Private Git checkpoints

Each recorded trusted writable native session may own a bare shadow Git repository below its
canonical directory. All commands specify that private Git directory and a scrubbed environment;
disable global/system config, hooks, templates, attributes/filters, fsmonitor, external diff and
network helpers. Feed raw blobs using `hash-object --no-filters --stdin`, build literal NUL trees
and private commit refs. Never run Git add/reset/clean against the user's repository or index.
Non-Git folders use the same private repository. Read-only, plan, untrusted and no-history contexts
report checkpoint unavailability instead of creating durable snapshots.

Before/after each permission-admitted mutation, compare the whole eligible tree, including shell
writes, not merely tool-reported mutated paths. Metadata traversal skips denied/protected paths,
Git/harness state, dependencies, symlinks, hardlinks, special files and worktree-ignored paths.
Checkpoint reads use current read permissions; an ask/deny decision excludes the path. Secret-shaped
names/content are excluded, never redacted into a supposedly exact snapshot. Report exclusion
reasons and quota coverage. Preserve eligible binary bytes and executable mode; represent deletion
and rename as path changes. Starting quotas: 5,000 files, 2 MiB per file, 64 MiB per snapshot.
Git-ignore evaluation must not read denied rule files; exclude the affected subtree conservatively.

Capture the pre-existing dirty/untracked tree as a baseline. Each step records before/after commits
and eligible coverage. Changes to excluded paths are explicitly outside restore coverage. Snapshots
are private, session-owned and referenced from the graph/step records. Pins survive retention;
prune only unreachable/unpinned refs/blobs under exclusive session ownership. Restore journals
and branch nodes are roots; a live or interrupted restore prevents destructive prune.

## Preview, conflict checks and interrupted restore

Restore previews list selected paths, before/after SHA256, mode/deletion and eligibility. Expected
current content is the post-step snapshot, so newer external changes are conflicts. Recheck trust,
profile, path ancestors, permissions and exact content before every mutation. A user may choose
conversation-only rewind if no eligible file coverage exists. No implicit force/overwrite option.

A multi-file restore is not atomic. Commit a journal with immutable before-images, desired content,
expected hashes and per-file progress before changing files. Stage private same-directory files;
vacate an existing target into a unique recovery hold, verify the displaced bytes, then install
using no-clobber creation. Preserve a concurrently recreated path and its recovery hold as a
conflict. Avoid the blind compare-then-overwriting-rename window. Fsync boundaries and progress;
on interruption leave a paused journal with explicit finish/rollback choices. Rollback uses the
same expected-content checks and preserves edits made after partial restore. Never switch model
context while a file restore is incomplete. Clear only verified holds after journal completion.

## Surfaces and acceptance

CLI session tree/fork/rewind/checkpoints/restore/prune uses the shared service for inactive sessions;
live slash commands use the owned engine contract. `/tree`, `/fork`, `/rewind`, checkpoint diff and
restore preview identify ids and instructions usable from both surfaces. Navigation preserves the
old branch and costs; explicit fork selection/resume continues the new independent session.

Test exact branches across compaction, absent historical evidence, tool-pair validity, stable images,
independent fork usage/notes, Codex generated requests/rejections, stale control and head journals.
Real files cover dirty/untracked/binary/executable/deleted/renamed/ignored/secret/oversized files,
symlink/hardlink/special/path escapes, hostile Git config/hooks/filters, external concurrent changes,
interrupted multi-file finish/rollback and unreachable-only prune. Actual rendered backtrack/tree
keyboard test. Full macOS/Linux suites and a compiled branch/restore smoke retain all six prior
smokes. Document platform/vendor limitations and exact evidence before starting D.

## Restore runtime feasibility and review decisions

Path validation alone leaves a parent-directory replacement race. Restore and snapshot file reads
therefore open each ancestor with `openat(O_DIRECTORY|O_NOFOLLOW)` and pin the resulting directory
handle. Mutation uses directory-relative `renameat`, `linkat` and `unlinkat`; installing a target
uses no-clobber `linkat`. Reopen/compare directory identity around operations and retain recovery
holds when an external rename prevents safe completion. Hash/mode comparisons still detect file
changes; no promise is made to detect an edit that recreates exactly the expected bytes and mode.

Bun's bundled TinyCC compiles a small fixed-arity POSIX wrapper without an external compiler/SDK.
Fixed arity avoids the Darwin arm64 variadic `openat` ABI mismatch. Bun's compiler cannot consume
its virtual embedded file path, so release archives ship `sandbox-runtime/restore.c`; verify its
hash against the embedded source before loading. The install root remains protected by the M3
sandbox. Interpreted and standalone compiled probes passed on Darwin/Linux arm64, including
parent-symlink swap and recreated-target preservation. Full compiled CLI acceptance is still needed.

The graph cap cannot always be relieved by pruning: linear selected ancestry is protected. At
1,000 boundaries, explicitly fork the selected boundary into an independent session to continue.
Do not automatically erase ancestry. Checkpoint content views show bounded before/after text or
binary hash/mode/size, and report omitted coverage. Conversation rewind and file restore remain
separate explicit operations; interrupted file restore prevents conversation changes or dispatch.
