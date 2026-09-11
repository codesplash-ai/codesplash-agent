# M6 D — trusted extension API v1

Binding design, 2026-09-11. Implementation and acceptance are pending. C's
accepted source/evidence stays frozen; D builds on it. No new dependencies.

## References and loader decision

Inspected local Pi `core/extensions/{types,loader,runner}.ts` (factory registration,
UI capabilities and callback errors), OpenCode `core/plugin/host.ts` and
`core/tool/registry.ts` (scoped registrations and stale materializations), Codex
`plugin/src/lib.rs` (source identity), and Grok pager `user-guide/09-plugins.md`
(separate install/enable/trust). These are local reference snapshots, not vendor
compatibility promises. [Bun executable documentation](https://bun.sh/docs/bundler/executables)
describes the embedded runtime; the pinned Bun 1.3.14 probe is the acceptance
authority for external loading. The macOS source/compiled probe loads external
TS, a relative TS dependency and a local CommonJS package twice with independent
counters. Retained probe: `docs/private/m6-acceptance/probes/m6d-loader.ts`.

Each configured entry names a dedicated root directory and a relative TS/JS
entry. Review hashes every regular file, including dependency packages and assets
(4096 entries, 512 MiB); links and special files are refused. Activation copies
verified bytes to a unique private snapshot directory per session/generation.
Static dependencies must resolve inside the snapshot or to runtime builtins.
There is no package auto-install or project auto-discovery. Native dynamic import
loads the snapshot factory. A query string on only the entry is insufficient:
it would reuse transitive module globals. Snapshot files remain until owned work
settles. Ordinary module state is isolated; arbitrary process globals are not.

## Trust and configuration

`[extensions.entries.ID]`: `root`, `entry`, inactive `enabled`, explicit `overrides`
and scalar `flags`. IDs are lowercase, at most 32 characters; at most 32 entries.
`extensions.disabled` and unconditional `--no-extensions` provide recovery.
Source review binds canonical cwd/root, all bytes, config/provenance and policy.
`extensions list/show/enable/disable/trust --fingerprint` uses source-preserving
edits and inert review. Managed extension IDs form an execution allowlist.

**This is trusted code running with the harness process's privileges.** Neither
the API nor the M3 subprocess sandbox confines imports, direct I/O, globals,
native addons or threads. JavaScript cannot forcibly terminate synchronous loops.
Trust review and startup explicitly disclose this. Use C command hooks for
bounded OS-enforced external execution. Changed sources require fresh review.
Relative/dependency imports are covered by the snapshot; computed imports and
direct runtime escape APIs are outside the API-mediated ownership contract.

## API and publication

The module exports a default factory receiving `api.version === 1`, owner ID,
generation, cwd, owner abort signal, registration methods and owned services.
Factory registrations are staged, bounded and sealed before publication. Names
are scoped to the extension. Collisions fail the whole stage. Tools can select
an explicit ordinary built-in override only if config also selects it; hidden
tools, permission, plan, context, skill and memory intrinsics cannot be replaced.
Override permissions use the extension identity, preserving the original tool's
policy floor and target extraction as additional restrictions.

Tools declare bounded offline JSON schemas, conservative effects, optional
read-only classification/targets, and an async run callback with cancellation
and bounded streaming progress. Validate inputs before classification and again
after C rewrites. All calls use the loop's permissions, hooks, checkpoints,
sanitization, output retention and actual outcome accounting. No API bypass for
nested tool execution. Custom permission IDs are `ext_ID_24hex`; approvals bind
source hash/generation and cannot be persisted across generations.

Lifecycle subscriptions observe the 22 C live events, with bounded sanitized
fields. They cannot rewrite gates or approve actions; C owns those semantics.
Callbacks execute serially with owned cancellation and deadlines. Failures
quarantine the owner and reject future API callbacks, while preserving recorded
effects and the rest of the session. History replay never invokes subscribers.

Commands use `/extensions run ID/COMMAND ARGUMENT`, with namespaced completion
and flags from config or explicit CLI invocation. Commands run only through idle
session admission. UI supports attributed status/widget text, dialogs through
the existing correlated form channel, and explicit composer replacement through
an interactive adapter. Focus stays with the existing dialog/composer controller;
ownership clear removes contributions. Headless reports unsupported UI, never
fabricates user responses. Completion and editor operations are bounded and
generation fenced; raw terminal access/custom arbitrary renderer replacement is
outside v1.

Providers register namespaced models and streaming adapters with validated
catalog limits. They cannot override unrelated providers or receive their keys.
Optional auth resolves only this provider's credential, once for an owned stream;
API credentials are added to output sanitization. Unknown pricing stays unknown.
Auxiliary model requests use the same model selection/streaming usage accounting
path and are subordinate to the active session's cancellation/budget.

Owned timers, subscriptions, dialogs, callbacks and streams carry the activation
generation. Asynchronous deadlines detach noncooperative trusted promises only
after revoking every API capability; direct effects cannot be rolled back.
Close clears UI/timers and aborts callbacks before releasing snapshot files.
Reload stages and validates first, admits an idle transition and publishes one
registry generation; failure keeps the previous registry. Provider changes that
affect the active model require a new session. No claim of unloading JS modules
or reversing top-level effects; code using process globals may require restart.

## Acceptance

Focused tests must cover inert review, byte changes/dependencies/symlinks,
failed stage preservation, streaming schema/target/permission/checkpoint paths,
protected override refusal, provider/auth usage and secret isolation, UI/headless
behavior, live-event replay exclusion, two sessions, cancellation/late callbacks,
reload and close. Full macOS/Linux suites plus accumulated compiled smokes and
an external extension smoke (TS, relative and package dependencies) gate D.
E packaging and F public SDK remain separate pending tranches.
