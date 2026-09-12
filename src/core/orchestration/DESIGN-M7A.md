# M7 A — shared ownership foundations

Binding implementation contract, 2026-09-11. Scope and acceptance follow
`docs/private/m7-plan.md`; this tranche does not claim executable child sessions or PTYs.

## Composition and authority

TaskRegistry receives the root session's SessionStateAccess and bounded configuration. It journals
an owned task before invoking its callback, has a single root admission queue and holds a slot until
the callback actually settles. IDs are UUIDs; an owner epoch is independent of a PID. Reopening a
journal marks unfinished previous-owner work execution-uncertain, never automatically runs it.
No-history uses MemorySessionState. Returned records are copies. Every update asserts session
ownership and uses the current control revision. Journals retain at most 128 tasks; completed records
may be explicitly forgotten, never silently evicted while live. Pending callbacks are not serialized.
Child capability enforcement and aggregate provider accounting belong to C; A supplies admission.

Configuration exposes narrowing limits only, under orchestration: maxRunning 4 (1–16), maxQueued 32
(0–128), maxDepth 3 (1–8), maxTasks 128 (1–128), outputBytes 1 MiB (1 KiB–1 MiB). Managed required
orchestration values are ceilings, intersected with the effective user values; a managed ceiling must
not increase a user's smaller limit. Configuration does not enable unattended work.

## Mutations

MutationCoordinator admits a set of canonical absolute path claims atomically. An ancestor conflicts
with a descendant; disjoint paths can proceed. Resolve existing ancestors and reject hardlink aliases
in the existing tool policy. The native loop claims cwd plus declared target paths for any workspace
mutation, because its checkpoint is a workspace snapshot. This intentionally serializes checkpointed
writers in one workspace. Restore/apply/recovery use the same workspace admission. Permissions and tool/source identity are revalidated after waiting.

Coordination is shared across local processes in a private uid-specific temporary directory. A short
OS-backed registry lease serializes claim registration and admission. Each claim holds its own OS
lease until actual finalization. Waiting claims preserve FIFO among overlapping claims without
blocking disjoint ones. Dead-owner reclamation must acquire the old claim lease; a PID alone cannot
release a live claim. Files are private, bounded and validated. Corruption fails closed. At most 128
claims and 64 paths/claim; cancellation removes a waiting claim, never an executing writer. Ephemeral
coordination contains paths/owner identifiers only and is removed on orderly release; no conversation
or output history is stored there. Hard crashes leave stale entries reclaimable under lease.

Trusted extension callbacks race cancellation for responsiveness. ToolContext therefore supplies a
holdMutationUntil(actualPromise) fence. ExtensionRuntime registers the original callback promise;
the loop's deferred checkpoint finalization and release wait for all registered promises. A cancelled
noncooperative callback can keep its workspace unavailable until it settles or its process exits.
Native context/cwd/recovery transitions refuse while a deferred mutation finalizer remains active.
A failed finalizer fences subsequent mutations until checkpoint recovery is inspected in a new owner.
This is honest ownership; trusted JavaScript cannot be forcibly stopped in-process.

## Output and watchers

TaskOutput retains a byte-bounded UTF-8 tail with absolute byte cursors and explicit lost-output
indication. Known secrets are sanitized across chunks before retention. Terminal control sequences
are stripped by a streaming parser; callback/monitor consumers cannot mutate stored state. Reads
are capped at 64 KiB. No raw process output is persisted by A.

FileWatchService owns bounded recursive directory watches (64 roots, 512 handles, depth 32).
Subscriptions are reference counted; symlink traversal is refused. Events coalesce to a sorted unique
bounded set with an overflow/rescan marker. Rename rescans discover new directories. A slow subscriber has at most one active callback and one coalesced pending delivery. Errors surface
through subscription events; closing the last subscription releases timers and handles. F will apply
permission and trigger-loop policy before using this mechanism to admit prompts.

## Evidence required

Reference inspections: Pi core/tools/file-mutation-queue.ts (edit/write callers), Codex file-watcher
lib.rs, Grok task/admission.rs and subagent-resolution/definition.rs. Local Bun 1.3.14 host PTY probe
succeeded on macOS (tty stdin/stdout and interactive read); this is feasibility only, not a sandbox
or B acceptance claim. A tests exercise real filesystem overlap, cross-process ownership/death,
cancellation with an unsettled writer, corrupt journals, bounded output and watcher lifecycle.
Full macOS/Linux check/build/release and retained source/artifact hashes are required before A closes.
