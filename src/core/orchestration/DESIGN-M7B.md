# M7 B — owned interactive and background commands

Binding contract, 2026-09-11. A is accepted; this tranche implements O2/O3 command execution.
Child sessions and teams remain C/G. See the private M7 plan and A completion evidence.

## Execution boundary and transport

A new internal pty-supervisor role runs the actual hardened sandbox argv through Bun.Terminal.
Bun's PTY exit callback is stream lifecycle, not the process exit code; await proc.exited. Preserve
process-group termination, macOS descendant reaping, Linux hardening/seccomp, protected paths,
filtered environment and native denied-read policy. No unrestricted fallback. Fixed profiles only:
background processes cannot retain turn-scoped grants. Plan/readOnly execution removes write roots.
PTY ioctl/device access is enabled only for this role and its owned slave. Review found the pinned
runtime's allowPty option grants all user PTYs; leave it disabled. A fixed trusted macOS bootstrap
resolves its inherited tty with /usr/bin/tty, validates the device name, then execs sandbox-exec with
literal grants for that slave and /dev/tty, plus explicit denial of other tty/pty devices and ptmx.
The workload argv is always passed literally and never evaluated by the unsandboxed bootstrap.
Linux uses the existing isolated bwrap device/PID namespaces. Cross-terminal denial is a live gate.
The pinned Linux backend represents missing deny-write paths with temporary host mount points.
For a missing .codesplash root, preserve directory shape using an empty read-only bind: a file
placeholder breaks concurrent configuration reads with ENOTDIR while a background writer runs.
The backend cleans this empty mount point at exit; workspace writers retain A mutation ownership.

Parent → supervisor is bounded newline JSON: initial SupervisorInput envelope, then stdin/base64
(max 64 KiB decoded), resize (cols/rows 1–500), or eof. Supervisor → parent is bounded newline JSON:
ready, output/base64, and result. Only the trusted supervisor creates frames; child bytes are encoded
as data and cannot forge process-control frames. Every terminal has an owned random ID, a 1-hour
maximum lifetime and cancellation. Output remains bounded before any slow consumer. Interactive secret sanitization uses bounded KMP
prefix tracking (256 secrets/128 KiB total pattern text) to retain possible split-secret prefixes
without withholding unrelated short prompts. Other transports retain their prior behavior. Stdin queued
before initialization is bounded. Close/abort kills and reaps; malformed/oversized frames fail closed.

Feasibility: local actual hardened argv probes passed on macOS/Linux: tty stdin/stdout, 27×91 sizing,
interactive input, denied outside read and denied workspace write in read-only mode. Without the
macOS PTY rules, stty ioctl failed. Evidence: private m7b-*-pty-*.log and sandbox-terminal.ts. References:
Codex core/src/unified_exec/{process.rs,process_manager.rs,shell_snapshot.rs}; installed Bun 1.3.14
Terminal declarations; pinned sandbox-runtime macOS allowPty generation. Compiled lifecycle tests
and resize/output/descendant probes still gate shipped behavior.

## Native command owner

One native task owner per session uses A TaskRegistry. exec_command goes through the ordinary loop's
permission/guardian/hooks and retains the bash permission floor. Its command is reviewed as shell
code. An explicit readOnly command uses an enforced read-only profile; unknown workspace effects
retain the loop's mutation/checkpoint claim through actual command completion using holdMutationUntil.
Backgrounding never releases a live writer's claim. Read-only commands can run concurrently;
checkpointed writers serialize conservatively within a workspace.

exec_command returns sanitized output and a stable task/session ID after completion or a bounded
yield (default 1s, max 30s). Ctrl+B releases the foreground wait while the task owner remains live.
Interrupt before that handoff stops the command; after handoff task_kill targets its owned ID.
write_stdin revalidates live owner, original profile/mode and fixed authority and has its own ordinary
permission request; no ambient PID is accepted. Resizing and output do not admit a new shell command.
Task output/wait-any/all/kill/monitor controls have bounded IDs, reads and waits; no hidden infinite poll.
Closing the session closes every command. Cwd/config/mode transitions cannot silently transfer a
live command into a different authority. No task resumes an old process after reopening a journal.

CLI/TUI /tasks and SDK expose the same controller, including stdin/resize and bounded monitoring.
`!command` executes through the native tool/approval boundary and records the command/result as
context without calling a provider. `!!command` uses the same boundary but excludes command and
output from model history; its explicit local task/transcript presentation is still visible. Neither
prefix is parsed as ordinary model instructions or bypasses approval. Headless responders still decline.

## Shell state

Shell state is an explicit bounded snapshot of a supported shell (bash/zsh), environment values,
aliases and functions. Snapshot review/trust is separate from config loading and uses exact bytes /
fingerprint; changed content invalidates trust. Capture accepts explicitly selected shell definitions,
not implicit startup-file execution. It captures permitted inherited environment values after filtering
and combines explicitly provided alias/function source. Never execute real user startup files just
because $SHELL points to them. Source may contain code, so present full content at review and replay
only under the native sandbox. No named secrets, startup-injection environment keys or raw host
credentials are imported. Test benign aliases/functions/env and changed/untrusted/secret-shaped input.
A selected snapshot and shell path form part of the command authority and approval description.

## Acceptance

Real local commands and scripted providers only. Verify PTY tty/resize/stdin, bounded floods,
malformed frames, timeout/interrupt/close/descendants, task ownership/output/wait/monitor, approval
routing, context exclusion, shell snapshot filtering/trust and no-history recovery. Add a compiled
terminal/task smoke to the sixteen existing gates, plus public SDK tests. Both frozen platform source
manifests and independent archive/package hashes must match before B closes.
