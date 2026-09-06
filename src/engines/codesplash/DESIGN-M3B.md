# M3 tranche 2 — native execution boundary

Implements the approved private M3 completion plan. The initial offline baseline is 1,158
passing tests (2026-09-05). Approval modes and execution privileges are independent.

## Backend decision

Use exactly `@anthropic-ai/sandbox-runtime@0.0.75` (Apache-2.0), locked by `bun.lock`.
This is an explicit exception to M3 tranche 1's dependency freeze. It supplies Seatbelt,
bwrap/seccomp, authenticated HTTP/SOCKS brokers, and violation attribution. Upstream source:
https://github.com/anthropics/sandbox-runtime. Never enable its weaker-isolation options.
Treat missing seccomp and dependency warnings as fatal, not as permission to weaken isolation.
`shell-quote@1.10.0` (MIT) decodes only the pinned backend's generated wrapper into literal argv;
model shell text is never parsed by this adapter. Wrapper/option shape changes fail closed.
Windows native command execution remains unsupported except explicitly confirmed full access.

The upstream manager is process-global. Each invocation therefore gets a separate trusted
supervisor process, immutable policy, private temporary directory, and broker lifetime. No
global manager runs in the model/session process. The supervisor launches an OS-confined
worker for file tools and commands. The parent passes input over stdin, never through shell
interpolation. Internal worker entry points run before ordinary CLI flag parsing and use the
same compiled executable (or source/dist CLI entry point in development).

## Contracts and invariants

- Profiles contain version, canonical workspace, base mode, read/write roots, protected paths,
  exact host:port grants and permitted environment names. Stable JSON is SHA-256 hashed.
  History-enabled sessions pin the profile next to their native transcript before execution.
  Per-invocation temporary/runtime paths are not part of the persistent hash.
- Restricted execution never falls back to a host command. File tools use the same kernel
  boundary as bash, including read/search. The trusted harness retains provider networking.
- Permissions are checked before execution, and execution access is checked independently.
  Plan mode narrows writes regardless of allow rules. Grants cannot override explicit deny
  rules, self-protection or read-only base profiles. A grant does not replay a failed command.
- Per-turn grants expire in the turn's finally block. Session grants expire at close/reconnect.
  `--auto`, bypass, cached approval and guardian output cannot authorize an escalation.
- Parent environment credentials never flow to supervisors/workers. Named secrets use
  `Bun.secrets` and only explicit per-command bindings. Redact before bounded output retention
  and again before persistence; separately drain stdout/stderr across chunk boundaries.
- Worker protocol is bounded JSON. Tool output is data; it cannot supply grants or modify
  supervisor configuration. Linux PID namespaces terminate descendants. On macOS an
  invocation-specific pair of kernel Mach lookup rules identifies inherited policies across
  fork/exec/setsid, independently of process groups and environment. The parent and supervisor
  stop, rescan, and kill only matching descendants. Nested sandbox policy application is
  denied. A tiny Bun C/FFI bridge calls system libproc/libsandbox without an external compiler.
  Output drains are independently bounded after exit, including inherited pipes.
- An observed violation may classify a failure; arbitrary stderr cannot. No automatic retry
  after possible side effects. Event logs omit input/output and respect no-history.
- Guardian is off by default, tool-free, budgeted and cancellable. Failure remains unapproved;
  deterministic denies and dangerous always-ask prompts take precedence.

## Implementation and verification

One integrator owns shared contracts/loop/CLI files. Build in the order specified in the
private plan, with focused tests and real macOS/Linux integration gates. Real Linux validation
also runs in an isolated Ubuntu 24.04 arm64 VM, using native kernel namespaces (not mocks).
Do not report a skipped backend test as enforcement evidence. Packaged Linux helpers retain
upstream license and SHA-256 integrity checks; all POSIX artifacts run compiled CLI/worker
enforcement smokes before archiving. CI covers macOS and Linux on arm64 and x64.

Before admission, scan accessible roots for multiply-linked inodes. All names must be
accounted for within roots of equal write privilege, with no sensitive/protected aliases.
macOS additionally denies new hardlinks; Linux read-only bind mounts separate write privileges.
The model cannot modify the harness installation. `bun run dev` makes a private copied
installation, allowing tools to edit the source checkout. This tool boundary assumes a trusted
harness and no hostile concurrent unconfined same-user host process modifying its files.

The Linux argv adapter repairs upstream 0.0.75's read-after-write mount ordering by replaying
an affected writable subtree's complete mount stack, including nested protection/credential
masks. Empty read-denial tmpfs mounts are remounted read-only. Regression tests require an
allowed operation first, then check both refusals and unchanged host contents.

Linux sensitive-read globs are resolved during the same bounded admission scan. Existing
files are masked with mode-000 read-only bind mounts after every ancestor restoration;
sensitive directories get empty read-only mounts. The sentinel itself is protected against
chmod/unlink. Redundant missing-child stubs under an already protected directory are skipped
because they would fail to initialize on a read-only parent. The verified compiled seccomp
helper is explicitly readable and its asset directory write-protected inside the boundary.

Trusted web tools use the same authenticated DNS-pinning broker as shell commands, including
HTTPS, rather than a second unrestricted fetch. Redirect hops and cached responses recheck
grants. The broker rejects private, loopback, link-local, shared, and multicast destinations.

Named-secret values enter only approved command environments. Trusted builtin file workers
also receive redaction values in stdin and sanitize whole file content before pagination,
matching, and truncation. Streaming redaction carries bounded raw suffixes and redacted
coverage so overlapping matches cannot leak prefixes. Redaction is not an encoded-exfiltration
boundary; approvals and network/filesystem grants govern deliberate disclosure.

Shell parser compatibility remains the conservative M3 tranche-1 parser; tree-sitter/heredoc
parity is an explicit roadmap deviation. Whole-process isolation and Windows remain M11.
