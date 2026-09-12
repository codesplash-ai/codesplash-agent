# M7 E — explicit goals and durable workflows

Binding design before E source. A–D locally accepted; E–H required. Reference inventory and
inspection notes: docs/private/m7e-design-notes.md (Codex goal accounting/steering; Grok workflow
journal/validation and goal phases). Native ChildBudget, TaskRegistry, input arbitration and M5
SessionStateAccess remain the execution and storage boundaries.

- One current explicit goal per thread; objective <=4096 bytes, explicit 1,000–1,000,000 token and
  1 second–1 hour time budgets, <=32 rounds. No inferred goals. Starting/resuming executable work
  always requires the native permission gate. Root-only controllers cannot be created by children.
- Persist versioned goal/workflow state in the session's owned control journal (memory for no-history).
  Combined automation state <=256 KiB. A running controller recovered by a new owner becomes paused;
  any intent without confirmed settlement becomes execution-uncertain. No PID-based resurrection.
- Controller is an owned task; children/commands have its parent edge and count against root capacity.
  Internal admission metadata carries parent and budget, never accepted from model JSON. Defer
  continuations while foreground input/turn/admission exists; serialize native runUserTool admission.
  Cancellation interrupts descendants and waits for actual settlement. Closing stops controllers.
- ChildBudget persists every reservation before provider dispatch and debits all worker, verifier,
  strategist and nested/auxiliary provider calls. Unknown usage conservatively spends reservations,
  marks uncertainty and pauses. Explicit review can clear uncertainty without refunding spent tokens.
  Resume preserves cumulative used tokens, elapsed wall time and rounds. Limits never imply success.
- Goal rounds run general worker, fixed builtin read-only verifier, then fixed read-only strategist
  when incomplete. Verifier must return strict JSON {complete:boolean,evidence:string}; completion
  additionally requires observed successful built-in read/search tool results and no failed tool
  results in that verifier execution. Persist evidence hashes. Invalid verdicts pause. Verification
  is evidence-backed model judgment, not a proof that arbitrary objectives are objectively satisfied.
- Workflow is a strict native JSON DAG of <=128 steps: prompt, command, verification and parallel
  joins. Prompt/command actions use native agent/exec_command permissions, checkpoints and sandbox.
  Parallel joins name dependencies; independent ready steps run concurrently within available root
  capacity. No evaluator or shell substitution added by the workflow engine. Outputs <=1024 bytes
  per step; durable task/evidence identities retain attribution. Source/config/cwd fingerprint pinned.
- Saved .codesplash/workflows/NAME.json definitions are disabled until exact-source CLI review/enable.
  SDK inline definitions require an exact content fingerprint and explicit execution approval.
  Runtime saved loads are fixed-path, bounded, trusted and respect explicit read deny/ask policy.
- Intent is recorded before every step; outcome only after actual task settlement. Successful steps
  are skipped on resume. A failed/uncertain step requires explicit per-step review to accept its
  externally checked outcome or authorize a retry. Automatic retry of unknown effects is forbidden.
  Resume revalidates definition/config/cwd, cumulative token/time limits and budget uncertainty.
- Native goal/workflow tools and equivalent SDK controls; CLI reviewed definition management and
  offline journal inspection under M5 ownership. G adds unified interactive orchestration controls.
  Migration only translates recognized literal semantics and leaves executable definitions disabled;
  unsupported Grok Rhai constructs are reported for manual review, never evaluated.
- Acceptance: real native scripted workers/verifiers/strategists, denied/failed verification, nested
  accounting/unknown usage, foreground priority, pause/close, command/parallel steps, source drift,
  durable restart and explicit uncertain recovery. Add compiled and packed SDK examples, preserve
  full macOS/Linux format/type/tests/build/accumulated release gates and source/artifact evidence.

E review refinements:
- Native HarnessTool has a pure explicit-approval floor, checked without resolving or parsing a
  deferred MCP tool's placeholder input. Native goal/workflow start/review and D worktree/endpoint
  controls preserve explicit approval even with ordinary allow rules or Guardian/hook auto-approval.
- Memory embedding requests reserve and debit the same ancestor ledger before network dispatch;
  provider-backed auxiliary calls already use the wrapped child provider. Unknown embeddings pause.
- M5 checkpoint scans can overlap unrelated task/usage/queue journal updates. Begin/end compare the
  checkpoint substate after scanning, then publish into the fresh session revision only if unchanged.
  Actual checkpoint edits still invalidate publication. Diagnostic cancellation retains its cause.
- CLI finite owners require explicit --apply/--trust, with per-invocation --approve for unattended
  fixtures/authorized runs. Startup failure removes owned signal handlers. No autostart service.
