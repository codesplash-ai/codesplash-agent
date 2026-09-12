# M7 C — scoped native child sessions

Binding contract, 2026-09-11. A/B are locally accepted. Written before C implementation.
Scope is O1/O5/X1/X2 and child portions of O2, with D–H following.

References read: Grok xai-grok-subagent-resolution/{definition,resume}.rs; Grok tools task/admission.rs;
Codex core/tools/handlers/multi_agents_v2/spawn.rs. Native integration inspected: CodesplashDriver
#openNative, ContextInputs, permission runtime, pluginLayers, TaskRegistry, SessionHandle/Recorder,
hook dispatch and SDK event routing. Adopt native boundaries rather than copying reference defaults.

## Ownership and authority contract
- One root TaskRegistry shared by command and child work. Nested work keeps parent edges/depth;
  reject saturated nested admission rather than queueing a dependency behind its waiting parent.
  Root submissions retain the bounded queue. Every reservation remains held through actual effects.
- Definition names are scoped (builtin/name, user/name, project/name, plugin/id/name) with explicit
  deterministic unqualified precedence project > config > user > builtin; plugin names remain qualified.
  Flat native Markdown scalar frontmatter, full JSON config definitions, strict known fields,
  <=64 definitions/64 KiB each. Unknown fields are errors, not ignored permission declarations.
- Explore/plan are real read-only sessions; general cannot exceed parent. Defaults: fresh context,
  inherited selected model, no MCP unless explicitly selected; all/none/named/except validated.
  Tools deny/allow, mode, read/write roots, hosts and orchestration limits only narrow ancestry.
  Parent current permission decisions are a ceiling, never a copied remembered approval cache.
- Child configuration is freshly resolved then narrowed on every boundary/refresh. Child source
  fingerprints are rechecked after queued admission and before execution. Plugin source verification
  remains mandatory. No direct cwd/config/model control can widen a child after admission.
- Root controls retain opaque task IDs. Parent events forward child requests with unique root
  correlation IDs and preserved alwaysAsk/forms/origin; responses route only to the exact child.
  Child output is sanitized and bounded. Usage includes child/descendant tokens and unpriced flags.
- Child tokens/time have explicit bounded defaults and ancestor ceilings. Provider request admission
  checks remaining budget, usage updates debit it; unknown usage stops continuation. No claim that
  unknown remote provider billing is a hard dollar ceiling. Requests cannot bypass the native loop.
- Resume is a new admitted execution using a retained child identity, definition hash, role/persona,
  model/cwd/config capability lineage, active extension identities and private native transcript. Uncertain prior execution requires
  explicit review; never resume PIDs or auto-replay unfinished tools. No-history child state stays
  in memory. Recorded child state/transcripts use owned child directories under the root journal.
- Forked M4 skills/commands use the same Agent dispatch after normal resource reads/import approvals;
  expanded instructions are the child task, never an extra permission grant. Import executable agent
  definitions as disabled until separately reviewed/activated. CLI supports list/show/create.
- Real SubagentStart/Stop equivalents become subagent.start/subagent.stop hook events; start is a gate.
  Existing bounded continuation handling remains; no unbounded recursive stop-hook loop.


## Definition and public control schema

[agents.definitions.NAME] supports description/prompt, enabled (default true), model, mode
(plan/default/accept-edits), tools (optional exact allowlist), denyTools, readRoots/writeRoots,
allowedHosts, mcp (all/none or only/except named sets), budgetTokens (1,000–1,000,000; default
65,536), timeoutMs (100–3,600,000; default 120,000). Markdown uses these flat scalar names;
list values are comma-separated scalars, mcp is all/none or only:a,b / except:a,b. Definition
mode/roots are ceilings. Models must already be available to the parent; inherited provider
credentials never become shell environment. Names and sources are part of identity.

Agent accepts agent, prompt, background/yieldMs, persona and resume identity. Default fresh
context and no implicit delegation from ordinary tool output. Explicit SDK/CLI user controls
use the same native tool boundary. Root /tasks output/wait/kill handles command and child IDs.
C implements validated transcript resume; D supplies live followup/peer messages and explicit
history forks. Persona is bounded additional instruction text, never a scope override.

## Acceptance

Scripted local providers must execute real tools. Attempt definition expansion, parent/managed
permission denial, plan writes, MCP selection outside parent, changed definition/plugin/config,
nested saturation and depth, cross-child request confusion, usage/budget/time exhaustion, close,
resume mismatch, no-history persistence and forked M4 invocation. Add compiled child smoke and
fresh packed SDK example. Full checks/builds/accumulated release smokes run on frozen matching
macOS/Linux source with independent artifacts. C completion is not M7 completion.

Review refinements: root-shared bounded memory retains nested no-history context after a child
closes. Forget descendants before their parent; durable lookup traverses only owned child journals.
State allocation happens after admission, so rejected submissions cannot exhaust retained state.
Definition tool allowlists do not disable fixed hidden context bootstrap reads; ancestor/config
read denials still apply and those internal tools never enter the model catalog. Child approvals
remain non-persistable. Start is a gate; stop runs once after teardown for every admitted start,
including failed/interrupted turns, with a bounded independent cleanup signal and ownership check.
Child foreground waits share Ctrl+B controls. Output streams redact known credentials across chunks.
Resume starts a new bounded execution budget; it does not reset a live ancestor budget. Imported
forked resources receive a .disabled suffix until explicitly reviewed and renamed.
