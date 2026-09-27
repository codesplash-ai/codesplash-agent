# Storage and platform backend boundaries

## Direct NFS/SMB state (F07)

The current session lease uses a local SQLite OS lock plus a host/PID/nonce owner record. Secure
restore uses pinned directory handles; journal recovery checks exact content identities. A remote
filesystem changes lock ownership, visibility, rename and durability guarantees. Changing journal
mode to TRUNCATE or adding a hostname suffix alone does not solve shared ownership or stale writes.

The supported design remains one authoritative process with local state, accessed through the
existing authenticated daemon/SSH boundary. Portable session export/import transfers reviewed
snapshots without making a network filesystem the live database. The local-filesystem guard remains.

A direct-sharing backend must implement a separate authority contract: fencing tokens verified at
commit, per-host immutable append records, checksummed committed manifests, deterministic recovery,
explicit partition behavior and no stale-owner reclamation from PID checks on another host. Live
SQLite WAL must not be shared. The filesystem/server matrix must establish no-replace publication,
crash persistence and lease semantics before this backend can be advertised. Required tests include
concurrent owners, disconnect/reconnect, server restart, stale client cache, interrupted fsync/rename,
clock skew, corrupt manifests and recovery that preserves conflicting user work. No representative
network mount or second client was supplied; this remains backend engineering plus host acceptance.

## Git sparse projection and future virtual filesystems (F08)

`codesplash projection create DEST LOCAL_REPO DIR...` previews a clone of a local repository's
committed Git objects and selected directories. Add `--apply --trust` to execute. Objects are copied
without hardlinks or shared alternates. The destination must not exist. Repository object reads
require unrestricted source read authority; explicit deny/ask rules cause refusal.

`codesplash projection expand DEST DIR... --apply --trust` adds directories only while the recorded
HEAD and working tree are unchanged. `projection status DEST` inspects the retained operation intent.
If an operation is interrupted, its non-ready journal stops further mutation; inspect the retained
checkout and Git sparse state before manual recovery. Existing/user-owned content is never deleted
by an automatic cleanup. Git cone mode also materializes repository-root files; this is a performance
selection, not an access-control boundary. It does not clone uncommitted source changes.

This is an independent content-store clone with explicit materialization, not a transparent virtual
filesystem. A future FUSE/ProjFS backend needs an immutable object manifest, path/case/symlink rules,
read/open fault handling, writable overlay copy-up, Git/index compatibility, crash journals, pinned
mount ownership, unmount/child cleanup and OS-specific denial gates. The daemon must not serve
private agent state through that filesystem. Driver distribution/installation and the selected OS
are explicit product/platform choices; no kernel extension was installed in this work.

## Windows (F17)

The sleep inhibitor uses a dedicated owned PowerShell/.NET process and calls
[SetThreadExecutionState](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate)
on the same held thread. It requests system availability during the active turn; it does not defeat
explicit user sleep. Shutdown releases the process/thread. Actual Windows behavior remains unaccepted.

The existing restricted-token/WFP helper uses shared account/ACL setup serialized by a lease.
Wrapping the entire agent with that helper and nesting model-tool profiles could either deadlock the
lease or combine grants. Whole-agent startup confinement therefore remains refused on Windows until
a backend with distinct parent/tool principals or verified nested restrictions exists. Do not use
an environment-variable label as proof of confinement. The implementation also needs credential
store access, process-tree cleanup, reparse/path denial and denial probes on the real target.

Windows storage currently uses pinned x64 FFI transactions. ARM64 needs a supported ABI/runtime or a
reviewed native helper exposing the same relative-handle, no-reparse, private-ACL and CAS semantics.
It must pass actual ARM64 crash/race tests before removing the architecture guard. Cross-compilation
or macOS unit fixtures cannot establish those properties.
