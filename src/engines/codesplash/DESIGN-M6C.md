# M6 C — typed hooks and execution gates

Binding implementation design, 2026-09-11, following accepted A/B. C remains unaccepted until
all code, integration, review, platform and compiled gates in `docs/private/m6-plan.md` pass.
No new protocol dependency is needed: native command input, M3 brokers, A source resolution,
B bounded JSON/schema work and M5 state/outputs provide the required foundations.

## Reference inspection and decisions

Local snapshots inspected under `/Users/kp/Workspace/open-source/`: Codex
`codex-rs/hooks/src/events/{pre_tool_use,stop}.rs`, `engine/{command_runner,output_parser}.rs`;
Grok `crates/codegen/xai-grok-hooks/src/{matcher,trust}.rs` and pager `docs/user-guide/10-hooks.md`;
Pi `packages/coding-agent/src/core/extensions/{runner,types}.ts`.

Keep explicit per-event results and ownership. Hook order is deterministic configuration order,
then handler id; rewrites are serial and each subsequent handler sees the current validated input.
This deliberately differs from completion-order or original-input-only rewrite contracts in the
references. Blocking failure refuses the affected operation. Project trust alone never approves
executable handlers. Native permission floors remain authoritative over hook allow decisions.

## Configuration, matching and review

`[hooks.handlers.ID]` entries are inactive by default. Handler ids use the same bounded lowercase
identifier grammar as MCP. At most 64 handlers, 32 event declarations per handler, 16 tool/source
matchers per handler. Matchers are exact names or one `*` prefix/suffix glob, never regex; each
matcher is at most 256 characters. Missing matchers select all eligible events. Tool identities are
the actual resolved names and source ids; deferred wrapper display names are not substitutes.

Command handlers provide literal `command`, ordered `args`, declared non-secret `environment`
references and optional `trustFiles`. HTTP handlers provide an HTTPS `url`, optional bearer-env
reference and explicit shared data fields. Exact literal loopback HTTP is an opt-in fixture setting.
Unknown settings and inline credentials are refused. Events, matchers, sharing, timing, effect
capabilities, source provenance, managed policy, cwd and executable/dependency fingerprints all
participate in trust. Shared bounded executable review will also serve subsequent extensions.

`codesplash hooks list/show/enable/disable/trust` edits or inspects A's selected raw user/project
source. `show` displays endpoint/program, shared fields, events, mode ceiling and trust fingerprint
without execution. Explicit `trust ID --fingerprint HASH` records only that reviewed source.
Idle `/hooks` exposes status/review and reload/disable; reload settles old owned work before swapping
an already-reviewed generation. Managed `hookHandlers` / `hookEvents` allowlists and a managed-only
source constraint can tighten eligibility. Disabled or untrusted gates never silently become allows:
configured enabled gates that cannot run block their affected operations with an actionable review
message. Invalid observational handlers report diagnostics without stopping the conversation.

## Typed event matrix

Version 1 envelopes include event id, event name, session/turn/operation ids when available,
configuration/runtime generation and handler/source attribution. Optional payload fields are explicitly
selected by the handler and sanitized. No raw provider request, chain-of-thought, credential store,
full transcript or ambient environment is an implicit input. Metadata is bounded and typed per event.

| Event | Role | Allowed result changes |
|---|---|---|
| session.start, session.resume | Blocking initialization plus observation | Deny; bounded additional context |
| session.end | Observation, bounded close phase | None |
| input.admit | Gate before provider admission | Deny; replace typed text; additional context |
| turn.start | Gate | Deny; additional context |
| turn.end | Observation for success/failure/interruption | None |
| tool.before | Gate after effective target/schema resolution | Deny/ask; input rewrite; additional context |
| tool.after, tool.error | After actual outcome is recorded | Bounded model-result text/context processing; never erase actual outcome or claim rollback |
| permission.request | Gate on the actual operation | Deny/ask; allow only an ordinary default prompt when explicitly reviewed for that capability |
| compaction.before | Gate | Deny; extra summary instructions/context; never arbitrary replacement message arrays |
| compaction.after, compaction.error | Observation | Bounded additional context after valid context publication |
| turn.stop | Opt-in continuation gate on genuine successful completion | Attributed continuation text within the shared budget |
| resource.before, resource.after | Explicit context/MCP resource lifecycle | Before: deny/context; after: context; hidden per-file reads are not separately exposed |
| config.before, config.after | Idle runtime/mode/source transitions | Before: deny; after: observation |
| cwd.before, cwd.after | Reviewed directory transition | Before: deny before publication; after: observation on the new owner |
| branch.before, branch.after | Branch/restore transitions | Before: deny; after: observation following actual publication |

Subagent events are reserved for M7 and cannot be enabled here. Hidden internal context, embeddings,
permission-control and housekeeping operations never automatically invoke arbitrary project tool
hooks. Their enclosing typed resource/transition events are the explicit supported policy surface.
Historical event/transcript replay does not dispatch hooks. Resume dispatches one live resume event;
it does not reconstruct previous tool events or repeat prior handlers.

## Handler execution and output

Blocking timeout defaults to 10 seconds, maximum 30 seconds; async observation defaults to 30 seconds,
maximum 30 seconds. At most 16 owned handler operations and four active async observations; no
unbounded waiting queue. Combined handler input/output/context work is bounded per event. Each
input/output JSON envelope is at most 128 KiB, 5,000 nodes and depth 32. Up to 1 MiB total additional
context per event is retained through ToolOutputStore with bounded previews; M4 still enforces the
model request budget. Diagnostics are at most 2 KiB and sanitized before publication.

Command handlers receive one JSON document on stdin and return one JSON object on stdout. Empty
stdout means no changes. Exit zero permits parsing; exit two denies a blocking event; other exit,
malformed/oversized output, unavailable enforcement and timeout fail blocking gates. Observation
errors produce diagnostics. Output supports only fields allowed by the event's typed contract:
version, decision/reason, input or text rewrite, context, result text, summary instructions, or stop
continuation. Unknown or conflicting fields fail validation. Async observers cannot return decisions,
rewrites or continuations. No prompt/agent hook runner is implicitly added.

Command execution uses a fixed M3 boundary with JSON stdin, filtered declared environment and bounded
owned drains. It never inherits temporary model-tool grants. Read-only is the handler default;
workspace writes require explicit source review and remain clamped by plan/read-only/managed policy.
There is no full-access or unsandboxed fallback. HTTP requests use fixed M3 destination grants and
DNS pinning, same-origin bounded redirects for safe discovery only, and no automatic POST retries.
Only explicitly declared sanitized payload fields are shared with the reviewed destination.

## Tool order and irreversible outcomes

Resolve actual target/generation → validate bounded input/schema → serial permitted before-hook
rewrites → validate again and extract current targets → final readonly/concurrency classification →
policy floors/deny/ask → bounded permission hooks → approval → checkpoint/sandbox execution → record
actual result → permitted post-processing/model context. Revalidate generation and source before
effects after any await. Input rewriting cannot change the tool id/name, source or generation.

Calls with changing hooks are barriers during preparation; only the final approval-free read-only
calls may be batched. All wrappers, including MCP resources, execute the revalidated effective input.
An explicit deny, dangerous floor, plan rule or sandbox restriction cannot be overridden by a hook.
Hook `allow` applies only to an ordinary default approval with the corresponding reviewed capability;
explicit ask and always-ask decisions continue to the user. Existing guardian reductions observe the
same rule. A post-hook failure leaves the real tool result and accounting recorded, appending an
attributed diagnostic instead of substituting a fictitious execution failure or rollback.

## Ownership, once receipts and recovery

A session owns each generation, handler process/request, cancellation scope and async callback.
Close/reload/cwd changes cancel and settle pending work; late outputs cannot modify a new generation.
Async handlers are observation-only. Handler enablement and source fingerprints are revalidated at
admission and dispatch. Failed staged validation preserves the previous runtime where its source
remains eligible; confirmed changed or revoked sources stop running immediately.

`once = never|turn|session` defines receipt scope. Persist invocation intent before an external effect
and terminal status afterward through M5 state; no-history uses memory only. A pending receipt after
process death is uncertain and is not automatically replayed. An uncertain once gate cannot silently
permit an operation. User-visible receipt inspection/acknowledgment or explicit disable/review provides
a recovery path. Payloads/credentials are not receipt keys. Receipts are bounded and source-specific;
changing cwd or handler fingerprints never inherits unrelated approvals or outputs.

## Stop and compaction budgets

Stop continuation requires `allowContinuation = true` in the trusted handler. At most eight per user
turn, at most 120 seconds after the first continuation, and an explicit bounded token allowance cover
all continuation provider requests. Conservative estimates reserve input/output when provider usage
is unavailable; real usage remains in the normal accounting path. Every continuation is visibly
attributed. Pending foreground input, steering, interruption, provider error, tool-round/doom limits,
or an exhausted budget ends continuation. An observational stop failure cannot initiate model work.

Compaction hooks cannot replace history arrays or break tool/result pairs. Additional instructions
enter the existing bounded summary request; post-context is added only after valid M5 context
boundaries are published. Failure produces the existing bounded recovery behavior, not recursive
hook-triggered compaction or paid retry loops.

## Migration, review and exit gates

Foreign hook import uses the existing preview/apply mechanism and always creates disabled entries.
Map only documented command/HTTP event aliases and exact supported fields; report unsupported matcher,
permission-return, async/prompt/subagent behavior without copying credential values. Do not activate
foreign approvals or treat imported project trust as executable trust.

Required evidence: real fixed-sandbox JSON command and loopback HTTP fixtures; event ordering and replay
exclusion; input/schema/target rewriting through direct and deferred tools; dangerous/deny/plan floors;
post-effect failure preservation; once/crash recovery; async overlap/close/reload; foreground precedence
and stop token/time/count budgets; compaction/branch/cwd regressions; rendered review/headless parity.
Run both complete platform suites/builds and all accumulated standalone smokes plus a compiled hook
lifecycle/gate fixture before accepting C. D–F remain separate unimplemented tranches.
