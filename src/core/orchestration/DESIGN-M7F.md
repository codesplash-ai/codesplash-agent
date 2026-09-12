# M7 F — durable schedules and file triggers

Binding before F implementation. A–E accepted; F–H required. References and proposed decisions
are recorded in docs/private/m7f-design-notes.md (Grok scheduler interval/types/occurrence journal,
Claude cronTasks/cronScheduler, Grok fs_watch, native FileWatchService and E workflow adapter).

- Private workspace-scoped schedule store keyed by canonical cwd, <=32 definitions, <=256 retained
  occurrences, <=512 KiB manifest. Strict versioned records and atomic private-file publication.
  Definitions/counters are separate from conversation history; explicit persistent scheduling is
  refused when configured history/managed policy forbids it. No automatic execution on import/open.
- Literal intervals 1 minute–7 days, or the explicit UTC minute-step cron subset `*/N * * * *`
  where N divides 60. Intervals anchor on enable time; cron aligns UTC minute boundaries. Unsupported
  cron/timezone constructs are rejected. Each schedule has explicit per-run token/time limits,
  1–1000 occurrence cap, <=1 million lifetime tokens and expiry <=7 days. No implicit infinite runs.
- One private OS worker lease per workspace; no PID-based ownership. Explicit service start or finite
  CLI worker (<=1 hour) owns timer/watch subscriptions and E workflow tasks. Closing drains actual
  owned work before releasing the lease. Services do not auto-start or install an OS daemon.
- Journal occurrence intent, advance next deadline and reserve lifetime tokens before dispatch.
  Missed cadence coalesces to one current occurrence. Only one occurrence executes at a time per
  workspace worker; root task admission still applies. E executes the prompt using real C children
  and B commands if requested by that child, preserving native permissions, budget and checkpoints.
- Confirm outcome/usage after actual settlement. Unknown usage spends the reserved allowance.
  Crash-recovered running occurrences are uncertain and disable recurrence until explicit review.
  Review acknowledges past effects; it never replays the same occurrence. Future enable requires
  the exact current schedule fingerprint and retains cumulative counters/remaining lifetime budget.
- Delete/stop cancels and drains active owned execution; pending/uncertain receipts remain available
  for review. Completed receipt retention may prune oldest confirmed entries, never uncertain ones.
- Native scheduler_create/list/delete plus common controls for enable/review/start/stop, SDK and CLI.
  Creating enabled work, enabling and starting an owner require explicit approval. A headless owner
  defaults to decline requests; --approve explicitly authorizes requests for that finite invocation.
  `/loop` is a native recurring-prompt wrapper using the same budgets and owner, not a second loop.
- File triggers use A's coalesced watch service with bounded literal workspace roots, exclusion of
  hidden/dependency/credential paths, <=128 changed paths and >=1-minute cooldown. Watch overflow or
  failure pauses recurrence for review. Suppress notifications while owned work is active and for
  a short settlement window; external edits during suppression may require another edit/manual run.
  This conservative policy prevents self-trigger feedback without pretending filesystem events
  identify their writer. No file contents or untrusted filenames become executable instructions.
- Imports preview exact source hashes and write disabled definitions only. Map native JSON and
  recognized Grok interval/Claude minute-step recurring prompt records; require explicit new native
  budgets/expiry/caps and report unsupported fields/semantics. Never import occurrence authority.
- Acceptance: injected-clock core tests plus actual native schedule/file fixtures, competing owner
  exclusion, crash/uncertain recovery, cadence/expiry/caps, config drift, delete/cancel, file bursts
  and feedback suppression. Compiled finite worker and fresh SDK example, then immutable Mac/Linux
  full checks/build/accumulated release acceptance. G/H follow; stop before M8.
