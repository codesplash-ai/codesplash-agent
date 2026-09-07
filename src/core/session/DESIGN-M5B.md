# M5 B — acknowledged input, safe steering, history and explicit drafts

Binding continuation of the approved M5 plan, after A's storage/platform acceptance. One
integrator; retain all A and M3/M4 tests and smokes. Implement state machine → native boundaries
→ Codex adapter → controller/composer/queue pane → history/stash → recovery and acceptance.

## State and acknowledgment

Add a typed SessionStateAccess backed by an already-owned SessionHandle or MemorySessionState.
It exposes read/revision/update and durable status. The engine receives it in OpenSessionOptions;
it never infers permission to write arbitrary control files from a transcript path. No-history uses
the identical model with no filesystem writes. A's immutable control commit acknowledges changes.

InputQueue owns versioned values.inputQueue, accepted history and named stashes. Each prompt has
a stable UUID/client submission id, submission fingerprint, order, intent (follow-up/steering/
interject), typed input, attachment descriptors, timestamps and status. Statuses are queued,
admitted, running, completed, cancelled, failed, blocked and execution-uncertain. Revisions fence
edit/reorder/remove/retry and stash pop/drop. Completed records may lose large bodies under bounded
retention while recent id/fingerprint acknowledgments prevent duplicate submission. Reject overflow
before acknowledgment; no silent eviction of pending work. Budgets: 64 KiB typed text, 16 attachment
references, 100 pending inputs, 100 recalled prompts and 32 stashes, all within A's 1 MiB state cap.

Persist admitted/running before any expansion, provider request or tool execution. A persistence
failure prevents dispatch. On restart, admitted/running become execution-uncertain; pending inputs
are held for explicit review/resume. Never replay approval answers or automatically retry uncertain
external effects. Duplicate submission ids with identical input return their existing acknowledgment;
changed content under the same id fails. Close pauses pending inputs and settles active cleanup.

Keep raw active input only in memory where persistence sanitization would change its meaning.
Persist sanitized text and mark those captures: after restart they require an edit before admission.
Opaque payloads and inline image bytes are not copied into the search index or event diagnostics.

## Execution ownership

EngineSession adds acknowledged submit and queue operations through a real queue implementation;
the old send primitive stays available for compatibility. The controller routes interactive sends
through submit when supported. Native and Codex advertise only implemented modes. Claude terminal
handoff does not acquire a fake native queue/steering API.

One queue runner dispatches at a time. Follow-up waits for the current turn, transcript persistence
and cleanup. Native admission cancels/settles M4 learning before expansion. Queue notification does
not start another loop while the native engine owns foreground admission or a maintenance operation.

Native steering is consumed inside the existing loop: between complete provider/tool rounds,
including after settling synthetic results for tools skipped before dispatch. Never insert user
content between tool calls and their results. Already dispatched parallel tools settle together;
pending approval is never answered by queued text. At a safe boundary, mark the steering input
admitted/running, validate attachments, prepare templates/includes under current permissions, append
its user message, replace the applicable context suffix, then continue that same provider loop.
If the turn ends before a steering boundary, admit it as a fresh turn and report that boundary.
Interject explicitly interrupts, cancels pending approval, awaits the complete turn/persistence
promise, then starts the selected queued input. Plain interrupt does not silently dispatch more work.

Codex uses generated turn/steer with expectedTurnId and clientUserMessageId. A method/version
rejection blocks the item with an actionable unsupported-operation error; it never silently changes
steering into interrupt/restart. Follow-ups wait for turn completion and a settled turn/start request.
Interject waits for the matching terminal notification before another turn/start; transport loss
makes possibly admitted work uncertain. Add the synchronous reservation missing in the old Codex
send path. No authenticated/metered acceptance calls: protocol fixtures prove adapter behavior only.

## Attachments and preparation

Queueing stores typed references, origin cwd, size and a fingerprint of file identity/timestamps;
it performs no templates, includes, shell substitutions or skill expansion. Capture content hashes
only when authorized bytes are read at admission. Missing/changed references block admission and
remain editable. Inline image bytes can remain ephemeral with an explicit unavailable-after-restart
descriptor; never manufacture a usable attachment from a redacted placeholder.

At admission, use current cwd/model/permissions and bounded, no-follow, singly-linked reads. Native
image authorization goes through a hidden read_file permission/profile gate, followed by a checked
read of that same file identity; data never bypasses deny rules. Keep binary payloads out of text
redaction; validate their MIME/signature, byte bounds and hash. The existing native input preparation
owns file mentions/includes/templates and their permission checks. Revalidate immediately before
provider use; policy/cwd changes invalidate old references. Attachment previews never execute content.

## User surfaces

Enter while busy acknowledges a follow-up. Explicit /steer and /interject choose other intents.
Clear the composer only after durable acknowledgment and only if its captured draft revision still
matches; preserve text/attachments typed while acknowledgment is pending. Empty/image-only input and
multiline editing keep their existing behavior. Queue pane and /queue expose status, ordering,
edit/remove/retry/review with revision checks. CLI session queue supports inspection and inactive
editing/review using the same state model; a second process cannot mutate a live engine's queue.

Record accepted typed prompts, scoped by project/engine. Reverse search/recall restores draft data,
not an executing submission. Explicit stash save/list/apply/pop/drop never autosaves keystrokes.
Named collisions fail; apply/pop cannot overwrite a newer/nonempty draft without an explicit choice.
Pop removes an item only after successful restoration. Missing attachments are shown, not silently
dropped. Clear history/stashes removes those records without deleting independent conversation
history. No-history history/stashes disappear at close and create no files.

## Acceptance

Pure state/revision/dedup/overflow/restart tests; durable acknowledgment failure and newer-draft tests;
native provider/tool/parallel batch/approval/compaction/learning boundaries; interject cleanup;
Codex steer/reservation/terminal notification/unsupported-method fixtures; attachment changes/denials;
history/stash collision and no-history tests; actual queue-pane keyboard test. Both platform suites
and compiled queue smoke, retaining every existing smoke. Update private evidence before C.
