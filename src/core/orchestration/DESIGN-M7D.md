# M7 D — worktrees, context forks and peer mailboxes

Binding design, written before D implementation. A–C locally accepted; D–H remain required.
References inspected: Codex multi_agents_v2/send_message.rs (queue-only delivery), native loop
provider/steering boundaries, native M5 Git/checkpoint storage and OS writer leases; Grok
xai-fast-worktree/src/git/safety/working_tree.rs (dirty, ignored, hidden-index and submodule refusal).

Binding implementation decisions:
- Dedicated real Git worktrees under the authorized repository's .codesplash-worktrees/<UUID>.
  This keeps new workspace roots inside the parent's physical authority. Child read/write roots
  narrow to that worktree; original metadata and all existing protected/denied roots remain protected.
  The worktree container is explicit generated content (normal Git status may show it as untracked).
- Private versioned manifests keyed by canonical repository identity, OS lease for mutations and
  active session claims, bounded 16 trees/5000 files/256 MiB each. Detached literal base commit;
  no repository hooks, fsmonitor, smudge filters or submodule execution in host lifecycle operations.
  Hydrate regular tracked files from raw objects after worktree add --no-checkout; unsupported
  symlink/gitlink trees are refused before effects. No host shell interpolation.
- Preview/apply records source and destination fingerprints, a raw-object source snapshot and
  recovery refs before publication. Conflict/check failure leaves destination intact with retained
  source/recovery refs for inspection and retry. Shared mutation coordination spans actual operation.
  Remove/GC refuse live ownership, dirty/ignored content, changed metadata and uncertain intent.
- Explicit history fork snapshots use completed message/tool pairs, a bounded source digest and
  independent future history. Worktree/directive are explicit spawn inputs and part of resume identity.
- Shared root graph retains parent edges and bounded attributed mailboxes. send_message queues data;
  delivery at a provider boundary never starts a new turn. Idle messages await explicit followup.
  wait_agent/interrupt_agent reuse owned task controls; explicit followup is a new admitted execution.
- Cross-session Unix endpoints are opt-in, private owner-checked files/sockets, random per-incarnation
  secrets, bounded framing/connections/messages and authenticated attribution. Stale endpoints cannot
  resume processes. SDK/CLI permissioned controls are equivalent to model controls. No daemon claim.
- Tests must exercise real Git operations, dirty/apply/conflict recovery and removal refusals,
  no-history forks, active messages, endpoint spoofing/floods/staleness and compiled distribution.


## Public boundaries and recovery

Worktree lifecycle is an explicit SDK/CLI/native tool action. Creating a worktree does not run
an agent. Spawn accepts an already-owned worktree ID, a bounded directive and context=fresh/fork;
worktree selection is immutable on resume. Parent original source/config identity stays a ceiling.
Plan/read-only children may use a worktree created by their writable parent, never create it themselves.
Host file hydration/snapshotting accepts only regular files, ignores no checks by invoking Git filters,
and refuses protected configuration/credential paths during apply. Recovery refs stay until explicit
review; automatic GC removes only clean inactive trees and never deletes recovery refs.

A peer message has immutable sender/recipient/message IDs, timestamp and bounded text. In-root
recipients must belong to the same root graph. Receiving data cannot start a provider request.
Provider-boundary delivery marks the text as peer data, not user authority. A public explicit
followup resumes an owned idle child through C admission, preserving source/role/capabilities.
Unix endpoint descriptors live in private short paths; permissions, inode and incarnation are checked.
A per-endpoint secret authenticates bounded messages; remote sender attribution must be verified or
explicitly labeled external capability holder, never trusted merely from a payload's sender field.
Endpoints disappear on owned close. Durable message intent is journaled under session ownership;
no-history roots retain messages in memory. No automatic socket reconnect/effect replay.

Tranche acceptance includes real temporary Git repositories, repeated CLI/SDK operations, separate
endpoint processes, managed/permission denial, changed source, conflict recovery and live children.
Frozen full macOS/Linux checks, JS builds and accumulated release/package smokes remain required.

## Review refinements

Host Git status/apply paths can invoke repository filters. Lifecycle uses raw snapshots instead,
and applies through M5's pinned no-symlink directory descriptors, no-clobber links and retained
holds. Before effects it records per-file intent and source/destination recovery refs. Conflict
preflight leaves destination intact; races preserve external files and require explicit guarded
rollback. Lost cleanup holds can be reconstructed only from hash-matching recovery objects.

Worktree copies/snapshots exclude credentials, configuration and denied read paths. The manifest
lists exact omitted paths; skip-worktree bits mark intentional omissions. Apply never publishes
those paths. GC tolerates only those exact omission flags with absent files; all other ignored,
excluded-on-disk, dirty or hidden-index content prevents removal. Bound apply to 128 files/2 MiB
per file, snapshots to 64 MiB and lifecycle loops to a two-minute deadline with 30-second subprocess
bounds. Shared mutation admission includes creation, inspection snapshots, apply, rollback and
removal; native controls retain actual callback settlement through cancellation. Standalone native
sessions opened at managed worktree paths acquire the same active lease as children.

Unix endpoints use private descriptors/sockets and rotating random bearer secrets. An authenticated
external sender is explicitly an external capability holder, never a claimed local user/agent.
Connections have fixed five-second lifetimes and bounded frames/queues. CLI data-only listeners
supply a separate-process probe and explicit local receive surface; they do not run model turns.

Final review applies M5's explicit-ask floor to host snapshots/restores: worktree approval does not
consume an ask rule for reading or writing an individual file. Read-ask paths are omitted; write-ask
paths cannot be published. Freshly resolved configuration/managed policy intersects the live parent
permission runtime before host operations. Review-1 retains the initial full matrix and the macOS
packed terminal-example readiness failure. The terminal example now waits on terminalReady; startup
failures have retained diagnostic output rather than only a generic task failure.
