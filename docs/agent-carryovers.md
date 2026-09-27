# Agent feature controls

## Launch and resume

```sh
codesplash /path/to/repo 'Explain this project'
codesplash --path /path/to/repo -p 'Review these files' --file 'src/a file.ts' --file diagram.png
printf 'Explain the recent changes\n' | codesplash /path/to/repo
codesplash /path/to/repo --continue
codesplash /path/to/repo --resume 'Exact session title or id'
codesplash /path/to/repo --search 'matching words'
codesplash run /path/to/repo -p 'Review the attachment' --file 'src/a file.ts'
```

An interactive invocation keeps its first positional as the project path; later words form the
seed. Use `-p`, `--prompt` or `--` to give a prompt without an initial path. A pipe requires EOF and
an attached controlling terminal for interactive use. Input is capped at 1 MiB and 32 attachments.
Images use the normal image admission path; other files use normal file attachment handling.
Resume is scoped to the chosen project and native engine. Search requires exactly one result;
continue selects the most recently updated active native session. No-history cannot resume.

## Recovery and streaming

All these controls default to false. Enable deliberately in `[codesplash]`:

```toml
[codesplash]
incrementalTools = true
stripImagesOn413 = true
partialFallback = true
fallbackModel = "a-configured-model-id"
detectStreamLoops = true
retryEmptyResponse = true
```

Early dispatch accepts only complete calls for the reviewed local read builtins. It stops at hooks,
approvals and mutation barriers. The normal dispatcher still validates inputs and permissions.
A stream failure settles started calls; a fallback never replays completed tool calls.

Image omission replaces image blocks only in the retried wire request. It emits a warning and
preserves original session attachments. Partial fallback replaces incomplete visible text/reasoning
with a superseded marker, retains audit events/usage and retries at most once per turn. Raw stream
consumers must apply later completed-item replacement events to obtain the final visible transcript.
The repetition detector recognizes eight exact repeats of a substantial suffix; it does not classify
semantic refusal/laziness. Empty-answer recovery retries once without inventing a new user message.

## Model metadata and caches

Custom models and reviewed catalog manifests accept `promptFamily` (`generic`, `openai`, `anthropic`,
`gemini`, `deepseek`, `qwen`, `llama`). These select shipped instructions, never arbitrary catalog text.
`promptCache` accepts `off` (default), `prefix`, or `conversation`. Anthropic prefix mode marks the
system block and final tool; conversation adds automatic cache placement. The implementation follows
[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), using
five-minute cache writes. Input accounting includes cache creation and its 25% input-price surcharge.
OpenAI-compatible adapters retain their provider caching behavior; `promptCache` does not promise
Anthropic placement on another protocol.

Content-free diagnostics identify wire model/tool/system/parameter/policy/history changes and loss
of reported cache hits. Only fixed categories and numeric values are recorded; prompts, tool input,
credentials and diagnostic hashes stay out of the logs. Named startup spans and literal Git/indexer
categories use the same local diagnostics and explicitly configured telemetry controls.

```sh
bun scripts/review-model-catalog.ts vendor-snapshot.json https://vendor.example/models reviewed-models.json
codesplash models refresh https://operator.example/reviewed-models.json --sha256 EXACT_REVIEWED_HASH
codesplash models discover http://127.0.0.1:11434
codesplash models discover-compatible http://127.0.0.1:1234
codesplash models install-runtime NAME https://vendor.example/runtime --sha256 EXACT_REVIEWED_HASH --apply
```

The review script creates an inert manifest and provenance/checklist sidecar. It does not scrape or
assert current vendor prices. Refresh sends an ETag only for the exact URL and checksum whose local
bytes still verify; a 304 never bypasses checksum review. Compatible discovery uses `/v1/models` and
never activates returned metadata. Runtime installation accepts one explicit executable (256 MiB
maximum), pins it by checksum and never runs it or downloads models. Archives and arbitrary package
install scripts are not supported. Configure/run supported local runtimes explicitly.

## Versioned tools and workspace navigation

Extensions may register the same tool name with distinct exact `version: "1.0.0"` / `"2.0.0"` values.
Use `extensionToolId(extensionId, name, version)` for exact selection. Versions have distinct wire and
source identities; permission rules retain the unversioned identity. Both remain subject to current
source/generation checks. Unversioned identifiers are unchanged. No automatic “latest,” migration or
versioned builtin override occurs. Tool descriptions and extension status expose the chosen version.

The native `workspace_symbols` tool accepts:

```json
{"operation":"index","paths":["src/a.ts","src/b.ts"],"references":true}
{"operation":"query","query":"SymbolName"}
```

Indexing uses reviewed language descriptors, workspace trust and read policy. It processes at most
64 explicit paths per call and stores at most 2,048 files/16 MiB per workspace. Each file retains up
to 256 symbols; optional LSP references are collected for the first 32 symbols, at most 256 locations
each. Query returns at most 200 symbols and only current readable locations. Re-index changed/new
files; content checks provide invalidation at use time. There is no background whole-workspace scan.
Tree-sitter descriptors must emit JSON arrays with `name` and zero-based UTF-16 `position` fields (or
LSP document-symbol shapes); arbitrary textual captures cannot form the graph. References require a
reviewed LSP provider. No-history sessions keep the index only in memory.

## Registered browser authentication

A custom **OpenAI-compatible** provider may configure `browserAuth` instead of an API key or cloud
identity. The provider must explicitly support a registered public client, S256 PKCE, variable-port
loopback callbacks and bearer tokens for its configured HTTPS resource origin. This does not grant
access to a vendor's subscription or official CLI identity.

```toml
[providers.company]
protocol = "openai"
baseUrl = "https://models.example/v1"
requiresKey = false
[providers.company.browserAuth]
clientId = "your-registered-public-client"
authorizationUrl = "https://identity.example/authorize"
tokenUrl = "https://identity.example/token"
revocationUrl = "https://identity.example/revoke"
resourceOrigin = "https://models.example"
scope = "model offline_access"
[[providers.company.models]]
id = "your-supported-model"
```

Run `codesplash identity login company`, open the printed URL in your external browser, and return to
the terminal. The one-use callback binds state and PKCE, validates the loopback host/path, and expires
after five minutes. Endpoint configuration is explicit and issuer-scoped; discovery and registration
are not guessed. Tokens use only the OS credential store. Refresh rotation is serialized; logout
removes local credentials even if configured remote revocation fails. Without a revocation endpoint,
logout is local only. Managed identity policy can restrict `browser-pkce` and the issuer origin.
The protocol follows [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252) and
[RFC 7636](https://www.rfc-editor.org/rfc/rfc7636); real provider/client acceptance remains required.

## Search and Git examples

`web_search` accepts `allowed_domains` and `blocked_domains` arrays. Domain entries are hostnames,
not URLs or wildcard patterns. Exact hosts/subdomains match; deny wins. An empty allow list matches
nothing. SDK-created search tools can impose operator ceilings that caller arguments only narrow.

Installed SDK examples 20–22 demonstrate dirty tracked-file guarding, explicit staged-content
commit-on-exit arming and merge/conflict handling. Each uses an isolated fixture repository and local
scripted provider. See [SDK examples](../examples/sdk/README.md) and the code before adapting them.
For Git projection and the remaining network/Windows backend boundaries, see
[storage/platform design](storage-platform-boundaries.md).

## Prepared worktree pools

```sh
codesplash worktree pool-fill 3 --base HEAD --apply --trust
codesplash worktree pool-take HEAD --apply --trust
codesplash worktree list
```

`pool-fill` prepares up to eight slots at the resolved commit within the existing 16-worktree limit.
`pool-take` assigns an existing slot exactly once in the durable journal. Use its returned ID in the
native agent `worktree` field, or work in its returned directory. Direct child/session claims also
consume prepared slots. Preparation and assignment use the normal worktree trust, permission and
history controls. Changed HEAD, active ownership, dirty/ignored/hidden files or changed read policy
refuse reuse and preserve the tree. No automatic reset or deletion occurs. Existing remove/GC controls
remain available. SDK/model worktree requests use actions `pool-fill` (with `count` and optional `base`)
and `pool-take` (optional `base`).

## Agent drafts and named personas

```sh
codesplash agents generate reviewer 'Review changes for correctness and cite evidence' --model YOUR_MODEL
codesplash agents generate reviewer 'Review changes for correctness and cite evidence' --model YOUR_MODEL --write
codesplash agents show project/reviewer --trust
codesplash agents enable project/reviewer --fingerprint REVIEWED_HASH --trust
codesplash agents personas --trust
```

Generation makes one bounded no-tool request to the explicitly selected configured model. It reports
usage; the generation request contains your brief and no project content. Only description/prompt prose is accepted; the resulting file
is disabled, plan-only and has no MCP inheritance. `--write` never overwrites an existing definition.
Review and explicit fingerprint activation remain separate. Calling generation again makes another
provider request; use the first invocation with `--write` when you want to retain that draft.

```toml
[agents.personas]
reviewer = "Review correctness and security; cite precise evidence."
planner = "Identify dependencies and produce an actionable plan."

[agents.definitions.review]
description = "Review changes"
prompt = "Inspect the assigned changes."
mode = "plan"
persona = "reviewer"
```

Personas follow the existing config precedence and workspace-trust rules. Definitions can select a
named default. Native/SDK child input `personaName` selects another registered persona; `persona`
supplies an inline override. Supplying both is rejected. Explicit selection wins over the definition
default. A resume retains its exact recorded selection/text and rejects changed configuration or
identity. Personas do not grant tools, permissions or models.

## Child transcript inspection

```sh
codesplash session children SESSION_ID
codesplash session children SESSION_ID CHILD_ID --limit 50
codesplash session children SESSION_ID CHILD_ID --offset 50 --limit 50 --fingerprint SNAPSHOT_HASH
```

The list includes nested recorded children and their latest task IDs. Inspection follows parent-owned
journal identities, not arbitrary paths. It pages visible text and tool calls/results in 16 KiB character
chunks, up to 100 chunks per page. Use the returned `next` and `fingerprint`; changed transcripts require
restarting pagination. Provider-private reasoning/signatures and binary attachments are omitted, and
terminal controls/known sensitive patterns are redacted. This shows retained model context, which may
have been compacted; it cannot recreate discarded history. No-history children have no disk transcript.

## Scheduler user services

```sh
codesplash scheduler service install --executable /absolute/path/to/codesplash --model YOUR_MODEL
codesplash scheduler service install --executable /absolute/path/to/codesplash --model YOUR_MODEL --apply --trust
codesplash scheduler service start --apply --trust
codesplash scheduler service status
codesplash scheduler service stop --apply
codesplash scheduler service uninstall --apply
```

The executable must be an installed standalone binary, not the Bun executable or a temporary build.
Preview prints the generated service descriptor. Installation writes an owned per-workspace macOS
LaunchAgent or Linux systemd user unit. Start loads/enables it; macOS also discovers installed
LaunchAgents at future login. Linux login startup is enabled by `start`. This does not configure Linux
lingering or a root/system service. The service renews the existing finite one-hour worker with a
60-second restart delay. It never enables disabled schedules or resets occurrence/token/expiry limits.
Every worker reopens configuration and applies current scheduling policy.

Approvals default to decline. Add `--approve` during installation only when you intend to accept
requests from the already reviewed schedules. Credentials are loaded through the normal configured
credential stores; no API keys or ambient shell environment are copied into service files. Config/data
roots are pinned in the descriptor. Stop/uninstall work without provider access. Changed descriptor
bytes refuse management/removal until inspected; files are never silently overwritten.

Both actual launchd and systemd-user lifecycles were checked with disposable inert workers, separately
from the existing real scheduled-agent smoke. Logout/reboot/device behavior still belongs to platform
acceptance. The manager contracts follow [Apple launchd](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
and [systemd service definitions](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml).

## Local Unix socket relay and public docs

```sh
codesplash relay --socket /private/owned/directory/service.sock --timeout-ms 300000 --max-bytes 67108864
bun run docs:build
```

The macOS/Linux relay forwards stdin/stdout to one private user-owned Unix socket, with backpressure,
a total byte budget, an idle timeout and a finite deadline. Stdin EOF shuts down only the write side
and drains the response. It creates no listener, reconnects nowhere and adds no credential or protocol.
Socket and parent must be owned/private; path identity changes refuse connection. The argv0 alias is
`codesplash-relay`. The POSIX implementation avoids the pinned Bun runtime's Unix half-close behavior.

The offline public docs now include this guide, roadmap status and storage/platform boundaries, with
safe links, tables, lists and code formatting. Only allowlisted local pages and HTTP(S) links become
links; private planning stays excluded. Building the site does not deploy it.
