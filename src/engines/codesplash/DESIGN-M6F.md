# M6 F — embedding SDK and milestone closure

Binding implementation design, 2026-09-11. Implements the approved private M6 F plan.
A–E acceptance is retained independently. F is pending until its final gates.

## Evidence and boundaries

The local Pi SDK and minimal/runtime examples separate session ownership from provider/tool
registration. Reuse CodeSplash's existing driver, controller, recorder and M5 state ownership.
Do not copy Pi's module-level default-provider mutation. Actual probes against E's emitted JS:
Bun 1.3.14 imports the native module successfully; Node 26.5.0 rejects its `bun:` import with
ERR_UNSUPPORTED_ESM_URL_SCHEME. Execution is supported on Bun >=1.3.14 on macOS/Linux;
Node may import the inert facade and types, but create/review calls explicitly require Bun.
No Node engine execution claim, implicit UI, remote connection or credential lookup at import.

## Public package

ESM exports `codesplash-agent` and `codesplash-agent/sdk` share a small lazy facade;
`codesplash-agent/extensions` exports the version-1 extension contract and pure identifier helpers.
Only these exports are supported. Internal engine/core paths are private. Publish emitted JS,
declarations, required runtime assets and eight numbered examples. This 0.x API can evolve in
minor releases; extension API version 1 retains D's contract. Test a real tarball installed in a
fresh external directory, including a strict consumer typecheck without repository devDependencies.
Declare ambient type dependencies needed by public declarations. No publishing in this tranche.

## Session ownership

`createAgentSession` creates a native session. Default is ephemeral; persistence is opt-in with
an explicit store root and optional resume ID. Use SessionStore/Repository/Recorder, replayed
view state and native transcript, monotonic sequence, usage and M5 queue recovery. Config's
history-disabled setting refuses persistence. Resume resolves the recorded current workspace;
explicit mismatched cwd is refused. Queued input stays held pending explicit recovery/review.

A shared core opener used by SDK, headless and TUI owns open-failure cleanup, native-ID recording
and recorder flush before publication. An optional abort signal fences publication and closes an
opening session once available; engine-owned startup deadlines still bound cooperative work.
SDK uses SessionController as the single event consumer and reducer, never a second agent loop.
Close drains engine events, aborts responders, flushes recording and releases the session lease.
Concurrent close calls share completion. No process-wide signal handlers are installed by SDK.

Expose submit acknowledgments, input queue snapshots, events and state subscriptions, a prompt
convenience that waits for its own input ID, interrupt/close, usage, model/context inspection,
compaction, permitted directory/recovery/presentation and MCP/hook/extension/plugin controls.
Prompt completion observes both the matching queue's terminal state and drained turn event;
blocked/uncertain inputs are reported explicitly, never automatically replayed. Listener failures
are isolated from recording/engine consumption. Async event feeds are opt-in, <=8 concurrent,
<=1024 events/8 MiB each; overflow fails that consumer explicitly. No unbounded replay buffer.

Approval/elicitation handlers receive the original typed request and an owned signal, with a
30-second deadline. No handler means decline/cancel; manual resolution must be explicitly selected.
No always-allow default. Late/failed handler results cannot resolve a different or closed request.
Host callbacks are trusted application code and cannot be forcibly killed; signals fence session APIs.

## Configuration and trusted host code

SDK configuration accepts the existing config path, profile and bounded TOML override array,
resolved through A's full layering and managed ceiling. It never injects an already-normalized
AgentConfig that bypasses managed policy. Explicit workspace trust and trust-store path are separate.
Review/trust helpers for file MCP/hooks/extensions use the same source fingerprint flow as CLI.
Installation and runtime code trust remain separate.

Trusted host extension factories (<=32 total owners including files) are supplied explicitly at
creation, with IDs, flags and explicit override names. Tools/providers convenience registrations
use owner `sdk`; identifiers are namespaced by the same D helpers. Factories are application
code already loaded by the host, so no fictitious on-disk trust receipt is created. A session-local
identity identifies that authority. Managed extension-ID and disable constraints still apply;
D's schema, permissions, checkpointing, auth redaction, usage, lifecycle, UI and teardown are reused.
No raw provider/permission/sandbox test override is exposed. Registry collision fails. Reload and
cwd transitions preserve host factories; provider-changing reload still requires a new session.

## Examples and acceptance

Eight numbered Bun examples use local scripted providers: ephemeral; recorded resume; streaming
tool with explicit approval; real MCP resource/elicitation; native external hook; provider/auth;
owned UI extension; bounded read-only Git workflow extension. Examples import only declared package
exports. Fixture data/servers/processes are owned and cleaned. No vendor account or paid calls.

Review E1–E9/X1/X2 against source and map to focused evidence. Test import side effects, Node
refusal, host-code managed constraints, multi-session isolation, cancellation, event overflow,
responder defaults, recorder failure/leases/resume, all examples and packed assets/types. Freeze
final source; run full macOS/Linux checks, JS/assets builds and accumulated unsigned compiled
release smokes plus packed SDK acceptance. Retain manifests/logs/archive hashes. Update private
plan/roadmap/gap to observed behavior and stop before M7. Signing, remote CI and publication remain
separate acceptance environments.

## Final review refinements

The public declaration graph needs only the declared Node ambient dependency. A fresh strict
consumer checks library declarations with skipLibCheck=false and explicit Node types. The eight
Bun examples additionally declare their own @types/bun development dependency and use Bun's normal
skipLibCheck=true: bun-types 1.3.14 has four upstream ambient-library errors with Node 24.13.3.
Do not attribute these to SDK declarations or claim they were fixed. Public raw/managed JSON schemas
also receive explicit package exports. Standalone CLI compilation is supported; arbitrary compiled
SDK host entry points are not a supported packaging path because worker dispatch belongs to CLI.

SDK exposes revision-checked queue controls, permission/rule controls and directory/sandbox inspection.
Prompt refuses paused queues; a resumed queue containing only terminal inputs may accept new work.
Recorded non-bypass modes survive resume unless an invocation override is present; current managed
constraints still apply. Missing native transcripts warn. Recheck workspace identity after acquiring
the writer lease. Concurrent waits and state listeners are bounded to 128 each. Async observer
rejections are isolated, and invalid responder data falls back to cancel/decline so it cannot strand
an interaction. Persistence requires an explicit nonempty root even for untyped JavaScript callers.

The packed runtime gate exercises native sandbox worker dispatch and checkpoint restore through
public exports. This exposed pending recorder outcome writes racing restore revision checks. Native
session recovery now drains recording before preview and after lifecycle hooks, preserving stale-
preview refusals while preventing owned recorder writes from racing blob validation and restore.

The first final macOS run caught an older memory fixture assuming persistence had settled 5 ms
after turn.completed. Native completion events precede transcript persistence and branch capture.
The fixture now waits for its exact native input's terminal queue status instead of a fixed delay.
Retain the initial gate evidence; re-freeze and repeat both platform gates after this test correction.
