# M4 — context, skills and memory

Extends DESIGN-M3B.md. Follow contracts → implementation → integration → review/fixes →
acceptance. Keep roadmap and company planning private. One integrator owns shared files;
no new dependencies in tranche A. Use `.ts` imports, targeted formatting and focused tests
during implementation; the integrator runs the full check and build at tranche acceptance.

## Tranches and dependency boundaries

A delivers context admission/compaction, prompt-cache diagnostics and context inspection/reminders.
B delivers governed rules/imports, mentions, templates, skills, and prompt variants.
C delivers cross-session memory. Each receives an implementation/acceptance record; A is not M4
completion. B/C receive detailed companion specs before their code is started, informed by A's
final contracts. Forked skill execution belongs to M7; M4 supplies inline skills and reports fork
requirements as unsupported. MCP definition migration may preview configuration but cannot activate
servers before M6. General session-store migration stays in M5; M4 memory storage is separate.

## Reference findings

Inspected local source checkouts on 2026-09-06:

- pi `packages/coding-agent/docs/compaction.md`: token-budgeted recent suffix, cuts before user
  or assistant messages rather than tool results, compaction records distinct from UI history,
  iterative summaries and auxiliary usage. Adopt those invariants, not its session-tree schema.
- opencode `packages/opencode/src/session/compaction.ts`: preserve recent token budget, shorten
  historical tool output, serialize source as conversation data, and handle split turns explicitly.
- pi `packages/coding-agent/src/core/skills.ts` and `prompt-templates.ts`: source provenance,
  bounded skill metadata, ignore-aware discovery, and non-recursive argument substitution.
  These inform B; their filesystem access does not replace our M3 boundary.

Current `prompt.ts` already prefers AGENTS.md with CLAUDE.md fallback. B extends that loader
with explicit vendor controls; it must not create a second conflicting loader.

## Tranche A contracts and ownership

| Phase | Module owner/files | Contract |
|---|---|---|
| 1 | `context.ts`, core engine types, config | Pure estimates, boundaries, inspection, configuration. |
| 2 | `transcript.ts`, `tool-output-store.ts` | Atomic native snapshots; bounded retained output. |
| 3 | `compaction.ts`, `loop.ts` | Summary execution, admission/recovery, usage, reminders. |
| 4 | `engine.ts`, controller, TUI, registry | Lifecycle/persistence, `/compact`, `/context`, output retrieval. |
| 5 | matching tests, README, CHANGELOG | Integration, distinct review pass, fixes, acceptance. |

### Estimates and admission

Add `ContextInspection` to `core/engine.ts`. Include model, window, system/tool/message token
estimates, total, requested output reserve, input budget, message count, context epoch, last
observed request tokens and prefix-change reasons. Label estimates explicitly; never mix them
with cumulative billed usage. Skills/MCP are not displayed as supported components until B/M6.

Use UTF-8 bytes / 3 rounded up with per-message overhead as a conservative planning heuristic;
images reserve 8192 tokens each, explicitly approximate. Reserve the model's actual maximum
output tokens plus 10% of its context window. A model with no remaining input budget refuses
clearly. Report actual provider input+cached counts separately and calibrate upward when observed
input exceeds the estimate for that same request. Reset calibration on model/prefix/epoch change.

`[codesplash].autoCompact` defaults true; `compactionStrategy` is `summary` (default) or `prune`.
Validate and round-trip these optional fields. Explicit `/compact` works even when automatic
compaction is disabled. `prune` performs no summary model call; if insufficient, explain the limit.

Before each normal provider call, check admission. Shorten older tool results first, preserving
the two most recent result messages. If still over budget, summarize once; permit at most two
summary operations per user turn. If the result still does not fit, fail with a smaller-prompt/
larger-model/new-session remedy. Do not loop trying identical compactions. A session circuit
breaker opens after two failed summaries; manual compaction can retry/reset it.

Recover only recognized context-overflow HTTP 400/413/422 errors before any stream event.
Permit one overflow retry per turn after a strictly smaller context; never replay tools or
classify auth, arbitrary bad requests, or output-token exhaustion as context overflow.

### Safe compaction and summary execution

Retain a recent suffix by estimated token budget (target one quarter of usable input), including
at least the latest message. Cut only at complete exchange boundaries, never immediately before
tool results or between a call and its results. Validate tool id pairing. Prefer retaining the
latest user request verbatim; when splitting a large turn, carry that request as separate
reference text alongside the summary. Never trim an oversized initial user request silently.

Serialize summarized material as labelled conversation data, remove model-bound reasoning
signatures, and label images as omitted. Use a dedicated no-tools request to the active provider,
with a maximum 2048 output tokens (also bounded by model output/window), no reasoning effort,
and a 60-second timeout linked to interrupt. Bound output to 16 KiB. Require a complete nonempty
text response and actual size reduction; tool calls, truncation, timeout and errors leave the
original candidate history intact. Do not stream summary text as a user-facing final answer.

If summary input is oversized, divide the prefix into bounded serialized chunks, summarize
sequentially with the prior handoff, at most four requests per compaction. A single source block
too large to admit fails with an actionable remedy; do not silently omit user instructions.
All chunk summaries must succeed before replacing live history. Preserve file paths, decisions,
verification evidence, constraints and pending tasks. Mark the resulting handoff as generated
reference material. It cannot authorize tools or replace current system/permission rules.

Count all summary usage, including failed requests with reported usage, in existing session
totals. Each compaction operation has a bounded request count, output cap and timeout. M2 has
no implemented monetary run-budget contract; do not claim one exists. Introduce no hidden
unbounded auxiliary spending or authenticated test calls.

### Persistence and output retention

Use atomic full snapshots of the existing v1 native JSONL message representation after history
rewrites. This keeps old readers compatible: they see the compacted messages. Existing event
JSONL remains the visible history. Native history before compaction is replaced, not archived;
state this in user docs. New writes use an exclusive 0600 temporary sibling, complete write and
fsync, then rename. Failure preserves the previous file and cleans only that temporary file.

Track a history revision separately from turn boundaries. Normal turns may append; a rewritten
history or any failed persistence attempt requires a full snapshot at the next write. Never
clear the dirty revision until success. Close waits for maintenance/persistence. No-history
sessions compact in memory and never create a transcript/output directory.

Retain sanitized tool results exceeding the 8 KiB model-result budget in a session output store,
up to 16 MiB total and 256 entries. Input is already bounded by each tool's execution cap; do not
call this a capture of unlimited raw output. Reference ids are opaque and session-scoped.
`read_tool_output` returns a bounded page by id/offset; it cannot open arbitrary paths or list
other sessions. Oldest entries may be evicted; missing references report expiry explicitly.
Disk-backed sessions retain outputs beside native history; no-history uses the same bounded
in-memory store. Sanitize before retaining, truncating, or returning content. Storage failure
degrades to a clearly truncated result, never execution failure or broader filesystem access.

### Prefix stability, reminders and surfaces

Sort tool specifications by name; preserve the current system prompt for an epoch. Fingerprint
model/provider, system text, tools and reasoning request parameters. Store hashes only, expose
changed field names through `/context`, and reset observed-size calibration when they change.
Compaction increments the context epoch. Prefix stability is not a promise of provider cache hits.

Provide a typed harness-only reminder channel: bounded text, fixed source identifiers, inserted
as text alongside settled tool results. It must not break call/result adjacency. Initially use
it for permission-mode transitions and output-retrieval guidance. Model tool arguments cannot
set trusted reminder metadata. Reminders consume the same message budget and redaction path.

`EngineSession.inspectContext?()` and `compact?(instructions?)` are optional. The controller
rejects unsupported engines clearly. Manual compaction emits maintenance turn start/completion
without a fake user message or final assistant answer, reserves admission synchronously, and
can be interrupted/closed. Reject model/policy edits during maintenance. `/context` returns a
snapshot without sending a provider request; `/compact [instructions]` uses the same context
manager as automatic/headless recovery. Cap instructions at 4000 characters. Do not reinterpret
ordinary headless prompts beginning with `/` as commands.

## Tranche A acceptance

Prove safe boundaries, recent-task preservation, pruning/spill retrieval, bounded hierarchical
summary, repeated failures, timeout/abort, small custom windows, prefix calibration, provider
overflow versus unrelated errors, usage totals, and no tools during compaction. Test both
provider message formats, interrupted maintenance followed by another turn, atomic snapshot
failure/recovery, legacy resume, no-history, and tool-output id/path isolation.

Run focused tests throughout, then full format/typecheck/tests/build and applicable compiled
platform smokes. Review the resulting diff against this spec in a separate pass. Record actual
counts and limitations; never declare all M4 complete from tranche A results.
