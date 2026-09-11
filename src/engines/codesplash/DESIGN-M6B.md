# M6 B — owned MCP clients and guarded external operations

Binding design, 2026-09-10. A is locally accepted; B remains in implementation
until its transport, interaction and both-platform release gates pass. The full
approved plan remains `docs/private/m6-plan.md`.

## Configuration and identity

Add named `[mcp.servers.ID]` tables to A's schema. `transport` is `stdio`, `http`
(Streamable HTTP), or explicitly selected legacy `sse`. No automatic transport
fallback. A stdio server supplies literal `command`/`args`; an HTTP server supplies
an absolute HTTP(S) `url`. Credentials are referenced by environment-variable
name or protected OAuth identity, never stored as header/token literals.
`enabled` defaults false. Defaults: 10s initialize, 30s request; hard cap 120s.
At most 32 configured servers, 5,000 catalog tools, 100 pagination pages, 16 MiB
per protocol frame/result, 8 MiB per decoded blob, 128 KiB per schema and bounded
depth/node counts. Repeated cursors, duplicates and unsupported schemas fail
discovery rather than produce a partial privileged catalog.

Config source/scope, canonical launch directory, transport identity and generation
identify a server. Explicit trust review binds the resolved server configuration
and relevant local executable/script content. Trusting a workspace alone does not
approve a server. `mcp add` persists an inert entry; enable/trust and connection
are separate. A changed source disables old trust and remembered tool approvals.
No configured/enabled server means no client/process/connection/credential state.

Management: `mcp add/list/show/remove/doctor/enable/disable/trust/login/logout` with
user/project scope and `/mcp` status/enable/disable/reconnect in an idle session.
Offline inspection never starts servers. Persist only the selected raw config
source with A's source-preserving editor and fingerprint checks.

## Transports and ownership

Pin the probed TypeScript MCP client 2.0.0 and Ajv 8.20.0 behind harness contracts;
do not expose SDK classes as the embedding API. Initially negotiate the supported
legacy initialize flow including 2025-11-25; unsupported negotiated versions fail.
Sampling, roots, task/agent execution and other unimplemented client capabilities
are not advertised. Unsupported server requests receive bounded protocol errors.

Stdio requires a persistent duplex supervisor path inside the existing M3 boundary.
Keep literal argv, filtered environment, private temp roots, verified Linux mounts/
seccomp, macOS cleanup identities, parent death/close cleanup and bounded drains.
Do not use the SDK's unrestricted process launcher. The initial supervisor envelope
is bounded before parsing; subsequent stdin/stdout carry protocol bytes without
text redaction corrupting JSON. Sanitize only parsed output/diagnostics. A session
owns its clients, subprocesses, pending requests, timers and cleanup promises.

HTTP/SSE use an injected trusted fetch that checks every URL/redirect through M3's
network policy and DNS-pinning broker. Never forward authorization across origins.
No arbitrary URL fetch from a resource identifier or elicitation message. Explicit
loopback development endpoints require a reviewed exact-origin exception; private
and metadata destinations are otherwise refused. Fixture transports may inject
loopback connectivity without weakening production defaults.

Initialization/discovery may be retried only as safe operations. A timed-out or
disconnected tool execution is uncertain and is never retried automatically.
Connection generations fence late replies. Reconnect disposes the old client,
revalidates trust/policy and invalidates schemas/approvals before publishing a new
catalog. A failed staged activation preserves the prior usable runtime where safe;
a confirmed dead transport is marked unavailable. Close cancels calls, reaps
descendants and settles owned background work. Replay never reexecutes MCP calls.

## Tools, discovery and results

External identities use a provider-safe deterministic name derived from source,
server and original tool name; exact original identities remain in diagnostics.
No external registration replaces hidden/context/permission/plan intrinsics.
Server/tool deny rules apply before connection/catalog publication and dispatch.
Readonly annotations are hints: unknown effects default to serial approval. Plan
and read-only policy cannot be weakened by a server annotation or extension.

All calls enter the existing guarded tool path, including deferred calls. Resolve
the actual tool/generation before schema validation, future hook rewrites, final
readonly classification, permission matching and execution. `search_tool` accepts
bounded keyword queries and `select:` identities; only selected permitted schemas
are loaded. `use_tool` resolves to the same actual operation, not an unguarded
recursive run function. Catalog revisions invalidate stale selections.

External effects are explicitly distinct from local checkpoint coverage. A remote
write cannot be undone by restoring workspace files. Preserve uncertain outcomes
and complete the provider tool-result pair on failures/cancellation. Validate
input schemas offline, reject remote refs and unsupported/excessive constructs,
and bound schema compilation and validation work. Retain text/structured/resource/
image results with provenance using existing M4 output limits; never treat server
instructions as trusted system policy.

## OAuth, resources and elicitation

Login is explicitly initiated. Use state/PKCE, exact callback/issuer/resource checks,
DCR where advertised, configured-client fallback, refresh serialization and logout.
Protected storage identity includes server/config identity. Native macOS keychain
was probed successfully; headless Linux without libsecret must visibly refuse
durable login, never silently write plaintext tokens. Mock auth servers are the
default acceptance path; no paid vendor account is required.

Support paginated resource/template list and bounded read. Preserve typed MIME/blob
data and source metadata, applying content budgets and sanitization before model
inclusion. A URI grants neither local file access nor arbitrary network access.

Elicitation is correlated with a live operation and generation, uses bounded
validated form fields/consent and shares the existing single pending-interaction
owner. Unsupported/sensitive credential forms are refused; no raw credential
entry through elicitation. It cannot replace a pending tool approval or become a
queued user prompt. Headless clients decline unless a supported responder is
injected. Cancellation/close settles any outstanding server request.

## Acceptance

Real sandboxed scripted stdio servers; loopback HTTP/SSE/OAuth fixtures; hostile
frames/schemas/cursors/identities; trust/source changes; input and output limits;
permission/readonly/concurrency tests through direct and deferred invocation;
elicitation/approval ownership; timeout uncertainty; reconnect/close and escaped
descendant cleanup. Run full macOS/Linux suites and all accumulated compiled
smokes plus MCP transport/management/interaction smokes. Retain exact source
manifest, logs and archives before claiming B accepted.

## Concrete integration contracts — 2026-09-11

Executable review resolves the command on the sandbox PATH and hashes its real target,
existing file arguments and explicitly declared `trustFiles` dependency trees. Review
is bounded to 4,096 entries / 512 MiB and detects changes while hashing. Dependencies
outside those declared inputs are not implicitly reviewed. Server environment entries
must be a subset of the pinned sandbox environment. Persistent stdio never inherits
temporary grants and requires an enforced OS sandbox. Managed policy participates in
the trust fingerprint; public-host managed ceilings prohibit loopback exceptions.

Provider tool names bind stable source paths/scopes, server and original tool name.
Connection generations and source fingerprints separately fence selections and
remembered approvals, so ordinary source edits do not silently rename policy targets.
Image results use existing top-level native image blocks beside attributed tool results,
preserving M4 budgeting and M5 transcript/portability handling. Non-image blobs retain
MIME/base64/provenance in the bounded tool-output store. At most eight images and
8 MiB total decoded binary content may be materialized from a result.

Explicit CLI login owns a five-minute literal loopback callback and prints its consent
URL. PKCE/discovery state stays in memory during this owned round trip. Only the final
issuer/resource/config-bound credentials enter protected storage. Refresh/logout serialize
across clients; a non-secret lease excludes another CLI process. Before rotating a refresh
token, protected state records an incomplete rotation; failure or process death requires
explicit login. OAuth never triggers an automatic repost of a tool operation.

The host form contract is `core/forms.ts`: at most 16 named string, integer, number,
boolean or string-enum fields with bounded labels, choices and values. URL/array/
unsupported forms and credential-shaped requests decline. One unambiguous live operation,
its generation and cancellation scope own each form. Initialization, background traffic
and ambiguous concurrent operations cannot prompt. Operation completion/timeout aborts
its outstanding form. UI forms use pending-request input ownership and never insert
answers into the foreground composer queue.

## Dispatch and lifecycle refinements — 2026-09-11

An optional exact `readOnlyTools` list records the user's review of effects. Layered declarations
intersect; server annotations alone never make a tool read-only. Other MCP tools are serial and
subject to mutation policy. HTTP effects have no local checkpoint; stdio mutations may checkpoint
workspace files while explicitly excluding external effects from restoration. A per-session MCP
approval includes source fingerprint and connection generation. Persistent "always allow" is not
offered for external tool prompts; explicit namespaced configuration rules remain available.

BM25 discovery tokenizes at most 512 words per permitted catalog entry and 16 query terms, selects
at most five results, and publishes at most 32 selections / 256 KiB of selected metadata and schemas.
Exact `select:server/original-name` and provider ids share the same selection path. `use_tool` resolves
before batching/permissions; its alias deny also applies. Resource access resolves `mcp_resource` to
a stable namespaced server/operation identity before the same guarded path. Catalog revisions clear
all selections. Fresh source/policy checks precede each turn and each external dispatch.

Native sessions own enabled trusted clients. Idle `/mcp` manages current connections; source enable,
trust and credential login remain explicit CLI operations. Permission-mode changes and branch
selection settle clients before publication. New cwd sessions prepare independent managers. MCP
forms are typed request events; headless consumers explicitly decline, even with automatic tool
approval. Form values are never copied into request-resolution transcript events.

Protected credential accounts remain fingerprint-specific. A separate private, non-secret cleanup
index tracks at most 128 account hashes per canonical cwd/server. Login records cleanup intent before
saving tokens. Refresh/login/logout share the stable server lock; logout can delete earlier accounts
after a source changes or is removed. Logout clears local state; it does not revoke remote tokens.
MCP settings import is inactive and refuses name collisions, unsupported definitions, literal
credential/environment settings and foreign approvals. Stdio environment references remain
non-secret; this tranche does not inject credential values into persistent process environments.

Final review found a resource-policy bypass: generic resource wrappers previously checked only
server eligibility. Resource list/template/read now apply the same exact allow/deny and managed
operation ceilings before selection and again before protocol dispatch. Their policy names are
`resources/list`, `resources/templates/list`, and `resources/read`. A regression proves denied
reads send no resource request. Idle status also revalidates sources before reporting readiness.
