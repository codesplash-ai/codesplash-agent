# Observability, evaluation and advanced tools

These capabilities belong to the native CodeSplash engine. Diagnostics use a versioned numeric
contract: no prompts, source text, reasoning, command arguments, URLs, exception messages or
filesystem paths enter diagnostic records. Ordinary session transcripts are a separate feature.

## Diagnostics and telemetry

`codesplash diagnostics status|crashes` summarizes retained records. `/feedback` shows a local
summary and export instructions. `trace export FILE` and `feedback export FILE` create private,
exclusive JSON files. `trace replay FILE` validates ordering and summarizes counts; it cannot
reissue tools or model calls. An operator can review the export and explicitly run
`feedback send FILE --url HTTPS_URL --yes`. Uploads are re-projected onto the numeric contract,
refuse redirects, have a deadline and never retry. There is no default upload destination.

Records include session/turn boundaries, provider first-event and gap latency, usage, retries,
compaction, private-checkpoint Git and search counts. Per-process markers detect unclean exits on
next startup without storing stack traces. Detection is best effort: PID reuse and abrupt power loss
can prevent a definitive crash diagnosis. A failing diagnostic sink never fails an agent turn.

Local logs retain at most four 2 MiB parts per trace; maintenance keeps 64 files / 64 MiB / 14 days
globally. Exports contain at most 20,000 records. Rotation can omit older events. `--no-history`
suppresses session diagnostics and telemetry. `CODESPLASH_DIAGNOSTICS_DISABLED=1` disables recording.

OTLP uses HTTP JSON with no SDK dependency, according to the
[OTLP specification](https://opentelemetry.io/docs/specs/otlp/). Enable it explicitly:

```sh
export CODESPLASH_OTLP_ENABLED=1
export CODESPLASH_OTLP_ENDPOINT=http://127.0.0.1:4318
export CODESPLASH_OTLP_SIGNALS=traces,metrics,logs
```

Remote destinations require HTTPS. `CODESPLASH_OTLP_TOKEN` optionally supplies a Bearer token.
`CODESPLASH_{TRACES,METRICS,LOGS}_DISABLED=1` independently suppresses a signal.
Analytics is separate: `CODESPLASH_ANALYTICS_ENABLED=1` and
`CODESPLASH_ANALYTICS_ENDPOINT` send only aggregate event counts. Its independent switch is
`CODESPLASH_ANALYTICS_DISABLED=1`. `CODESPLASH_TELEMETRY_DISABLED=1` or
`CODESPLASH_OFFLINE=1` disables all export. Queues hold 512 records, drop overflow, and use
two-second export deadlines with no retry. Short-lived CLI commands may exit before flushing;
native session close drains its exporter. Exporter failure/drop counters remain local.

## Behavioral evals

```sh
codesplash eval --fixture --output fixture.json
codesplash eval suite.json --model MODEL --budget-usd 1 --output candidate.json
codesplash eval suite.json --model MODEL --budget-usd 1 --judge JUDGE --output judged.json
codesplash eval compare baseline.json candidate.json
```

Suites are data-only JSON, not scripts:

```json
{"version":1,"minimumPassRate":1,"cases":[{"id":"write","prompt":"Write hello to result.txt","approveWrites":true,"expectedFiles":{"result.txt":"hello"}}]}
```

Each case gets an isolated workspace, native permissions/sandbox, explicit tool ceiling and
an equal share of the budget. Only the suite's explicit `approveWrites` allows write approvals.
Cases can assert file bytes, text and completed/failed/cancelled status. Fixtures cover native
writes, rate limiting, partial-stream failure, cancellation, cancelled approval and denied writes. The broader native
regression gates exercise malformed streams, compaction, owner crashes, task cleanup and workflow
recovery. Live tasks require a selected model and positive dollar allowance; missing pricing or
uncertain usage stops admission. Optional judges get a separate half of each case's allowance,
no tools and a bounded score schema. Scores are advisory, never a replacement for assertions.

Reports contain outcomes/counts/costs, not task text or model output. Comparisons require the same
suite hash and fixture/live mode; uncertain failed/cancelled live costs suppress the cost delta. They report pass-rate delta, cost delta and newly failing cases.
Set `minimumPassRate` before running. A failed acceptance threshold returns exit code 1. Fixture
success does not establish live model quality, provider account access or production reliability.

## Providers and model metadata

Custom OpenAI-protocol providers accept `api="responses"`, `transport="sse"|"websocket"`, and
`serviceTier="auto"|"default"|"flex"|"priority"`. Chat Completions remains the default and also
passes an explicit tier. WebSocket requires Responses. Models/limits/prices remain operator data.

Responses preserves encrypted reasoning items only in native history and removes them from
portable/foreign contexts. Tool results, image inputs, summaries and exclusive cached-token usage
are translated explicitly. SSE retries connection failures before streaming; truncated or failed
streams are never replayed. WebSocket uses a fresh connection and full native context per request,
without automatic reconnect or multiplexing. Frames/queues/timeouts are bounded. This is a
deliberately simpler connection policy than server-side continuation caching. See official
[Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses) and
[WebSocket guidance](https://developers.openai.com/api/docs/guides/websocket-mode).

`models list` shows bundled and cached metadata. `models refresh HTTPS_URL --sha256 HASH`
accepts a reviewed version-1 manifest containing `models` with the native model fields (`id`,
`provider`, `protocol`, `displayName`, `contextWindow`, `maxOutputTokens`, `supportsReasoning`,
`isDefault`, optional `pricing`). It verifies the exact bytes and caches them atomically. Cached
models can only hydrate already-configured providers with matching protocols; they cannot supply
endpoints, credentials or executable code. Corrupt caches fail closed. Offline use keeps the
last verified snapshot; there is no timer-based refresh or implicit expiration. Builds use the
checked-in catalog and pinned dependencies; they never fetch model metadata during compilation.

`models discover [OLLAMA_ORIGIN]` lists a local runtime's models without changing configuration.
`models pull OLLAMA_ORIGIN MODEL --apply` explicitly requests a download. Both accept only
loopback HTTP origins; pull is disabled offline. Discovery does not infer context limits/prices.

## Feature selection and tool ceilings

Use `run --features notebook,anchors,clock` or SDK `execution.features`. For interactive/native
server sessions set `CODESPLASH_AGENT_FEATURES` to the same comma-separated names before launch.
Explicit SDK fields override environment defaults. All advanced features are off by default.

`--toolset concise|plan|read-only|anchors` applies an actual dispatch ceiling, intersected with
`--tools` and `--exclude-tools`. A preset does not enable features or change permissions.
`tools list` and `tools schema NAME` expose version-1 built-in schemas with SHA-256 digests
and lifecycle stages (`stable` for the base toolset, `experimental` for opt-in advanced tools);
`tools presets` lists the ceilings. Existing extension generation checks still apply.

| Feature | Behavior and bounds |
|---|---|
| Base `read_file` | Signature-checked PNG/JPEG/GIF/WebP attachments and PDF text extraction, inside native read policy. Existing 5 MiB file cap applies. PDF offset/limit are pages, at most 10 pages and 50,000 output characters. No OCR, script execution or network asset fetching. |
| `notebook` | Stable cell-id replacement/insertion/deletion with exact SHA-256 precondition, 2 MiB notebook cap; edited code outputs reset, cells never execute. |
| `anchors` | `read_anchors` returns line hashes and file SHA; `edit_anchors` checks both boundary hashes and file SHA. Redacted reads refuse anchors; large files require ordinary bounded reads. |
| `code` | JavaScript only in the native OS worker, 64 KiB source and a 33-second process deadline. No privileged host-tool bridge. Always asks; native workspace checkpoints surround mutations. |
| `clock` | UTC time or abortable waits of at most 30 seconds. Existing M7 owned commands/tasks provide asynchronous execution and cleanup. |
| `browser` | Fresh Chromium profile, snapshots/screenshots, selectors and mouse/key input within explicit origins; no arbitrary page code, popups, downloads or operator profile reuse. Actions always ask; snapshots/screenshots do not submit input. |
| `generation` | Approved image/video jobs with durable intent, explicit polling/download and private artifact export; details below. |
| `plugins` | Rank descriptions in verified configured marketplaces; return inert suggestions. Never installs, enables or trusts components. |
| `environments` | Reviewed named local/container/SSH execution; details below. |

Headless `--auto` still declines always-ask tools. Use an interactive native session or an SDK
approval callback for those operations; feature selection is not approval.

Browser use requires `CODESPLASH_BROWSER_EXECUTABLE` pointing to installed Chromium and
`--browser-origins` or `CODESPLASH_BROWSER_ORIGINS`. Every request needs both an exact origin and
a native host grant; the DNS broker refuses private/rebinding destinations. Explicit literal
HTTP loopback origins are self-contained development grants; they do not extend general network policy. WebSockets and service workers are blocked.
The browser owns a fresh profile and closes on session close/cancellation. Computer actions in
this milestone operate within that browser viewport; global desktop/clipboard control is absent.
Playwright is packaged with releases; browsers are operator-installed.

## Generation and external environments

Set `CODESPLASH_IMAGE_MODEL` for the Image API and `CODESPLASH_VIDEO_MODEL` for Runway's video
API (for example, a reviewed `gen4.5` selection supporting text-only input). Image credentials use
`OPENAI_API_KEY`; video uses `RUNWAYML_API_SECRET`. Overrides:
`CODESPLASH_GENERATION_BASE_URL`, `CODESPLASH_GENERATION_KEY_ENV`, `CODESPLASH_VIDEO_BASE_URL`,
`CODESPLASH_VIDEO_KEY_ENV`. Defaults are the providers' HTTPS endpoints. The URLs/models/credential
bindings are operator configuration, never model-controlled arguments.

OpenAI's Videos API shut down September 24, 2026, so this implementation does not target it.
See the [official shutdown notice](https://developers.openai.com/api/reference/resources/videos/methods/create).
Images follow the [Image API](https://developers.openai.com/api/docs/guides/image-generation);
video uses Runway's documented text-only `image_to_video` flow, fixed five-second 1280:720 output,
version header and task polling. [Runway API guide](https://docs.dev.runwayml.com/guides/using-the-api/).

`generate_media` creates one 1024×1024 PNG or one video job. Default cap: two creates per session,
including uncertain requests; `CODESPLASH_GENERATION_MAX_JOBS` can choose 1–8. The cap survives
resume through stored intents. No automatic POST retry or continuous background polling occurs.
Downloads require completed jobs, are capped at 32 MiB, validate signatures, and use the native
DNS broker with an explicit host grant for the returned CDN URL. API credentials never accompany
artifact downloads. Job receipts omit prompts, credentials and signed artifact URLs.

Media billing is separate from language-model token accounting. Generation refuses a session
with `maxBudgetUsd`; its create approval explicitly describes separate billing. Offline mode
refuses remote generation. A cancelled POST may have completed remotely: inspect provider history,
do not assume cancellation refunded or prevented the job. Export completed artifacts with
`tools export-media STORE JOB DESTINATION --apply`; destinations must not already exist.

SDK `execution.environments` or `run --environments FILE` accepts at most 16 operator-reviewed entries:

```json
[
  {"id":"local","transport":"local"},
  {"id":"build","transport":"container","executable":"/usr/local/bin/docker","image":"example/image@sha256:REVIEWED_64_HEX_DIGEST"},
  {"id":"remote","transport":"ssh","host":"build.example.com","port":22,"user":"builder","identity":"/absolute/key","knownHosts":"/absolute/known_hosts"}
]
```

Models choose an id and bounded command, not transport flags. Commands retain Bash permission
floors and always ask. Local uses the native sandbox. Containers require an already-pulled
digest-pinned image, no network/host mounts, read-only root, dropped capabilities, process/memory
limits and owned cleanup. Images must provide `/bin/sh` and GNU/BusyBox-compatible `timeout`;
an in-container deadline bounds work even if the owning client crashes. SSH disables config files, forwarding and interactive auth; it requires
strict host keys, explicit identity/known-host files and a native host grant. Container entries may
specify an absolute `runtimeDirectory` for a rootless runtime. Runtime and credential paths must
be outside model-writable roots; transport clients get a private temporary home. An explicitly
configured SSH `127.0.0.1` endpoint with pinned host keys is the local-VM exception to public host grants. Commands use stdin,
not shell-interpolated connection arguments. Calls last at most 30 seconds. Closing SSH stops
the local transport; arbitrary remote daemons can outlive it. Remote effects cannot be rolled back
through local checkpoints. Installation and infrastructure provisioning are separate operator work.

## Hunk review, attribution and search

Native `session hunks SESSION CHECKPOINT PATH` (also `/hunks`) compares checkpoint before/after and current
bytes. `accept-hunk` records a decision; `reject-hunk` previews reversal. Applying requires the
current revision and `--apply`. Rejection uses the existing durable restore journal, pinned parent
descriptors and no-clobber installation. Unique unchanged context permits unrelated external edits;
conflicting/ambiguous context refuses mutation. Files over 2,000 lines / 256,000 combined characters,
binary/redacted files and incomplete checkpoints require whole-file recovery instead.

Attribution is temporal: `agent-checkpoint` denotes the native tool's checkpoint window;
`external-since-checkpoint` denotes later differences. External edits during the same window cannot
be proven to belong to the agent. Accepting a hunk does not change Git's index or commit anything.

`tools attribute commit|pr POLICY_JSON TEXT_FILE` writes a formatted preview to stdout. Policy:
`{"version":1,"commit":"trailer","pullRequest":"footer","agent":"CodeSplash"}`.
Either field can be `off`. Enabled formatting adds an idempotent `Assisted-by` trailer or explicit
PR footer; it never invents human authors, changes Git identity, commits or publishes.

`tools doctor` verifies the bundled ripgrep payload and repairs its private cache from those exact
bytes. Native grep stages a verified binary inside the sandbox for file enumeration, then retains
existing per-file permissions, secret scrubbing and JavaScript-regex semantics. No PATH lookup,
remote binary repair or automatic unverified fallback occurs. Source/SDK direct tool calls without
the native worker retain the pure-JS walker. macOS/Linux ARM64 and x64 payloads are pinned; acceptance
records identify which platforms actually ran.

Shell structural analysis recognizes quoted heredoc data and bounds nesting/size. Opaque
substitution, interpreter payloads and heredocs still require approval under the existing deny/ask
floors. `tools analyze-shell COMMAND` inspects structure without running it. This does not claim
complete Bash grammar or tree-sitter equivalence.
