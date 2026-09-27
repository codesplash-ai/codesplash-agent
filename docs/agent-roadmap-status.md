# Agent roadmap status — 2026-09-27

The original native-agent roadmap ends at **M11**. M11 is committed in `272358c`; the audit is
committed in `6edaf82`. The subsequent work below is committed in `ce99219` and closes original feature
carryovers. The [0.2.0 release handoff](roadmap-release-handoff-2026-09-27.md) preserves the full status snapshot and tracks production deployment. It does not introduce M12–M14 or reopen the recorded product no-go decisions.

The complete private inventory covers 109 original roadmap items and 416 historical comparison
rows. This public record summarizes every remaining workstream, acceptance gate and decision.
Implementation completion and production/platform acceptance are separate.

## Implemented in this continuation

| ID | Delivered behavior | Boundaries |
|---|---|---|
| F01 | Interactive seed/positional/piped prompts, repeatable literal `--file` paths, project-scoped ID/title/search/continue selection; headless file arguments | Interactive pipes need a controlling terminal; headless stream-JSON cannot mix file flags. Ambiguous matches fail. Files still pass engine admission and permission checks. |
| F02 | Opt-in dispatch of fully parsed read-only builtin calls before the response finishes | Only `read_file`, `glob`, `grep`, `read_tool_output`; approvals, hooks, mutations and other tools stop early dispatch. Results settle exactly once, including failure/interruption; no partial-tool fallback. |
| F03 | Reviewed model-family instructions selected by catalog metadata or known model names | Explicit `promptFamily` overrides inference. Unknown families stay generic. Paid quality evaluation remains A04. |
| F04 | Explicit Anthropic prefix/conversation cache placement, cache-write usage/cost, hashed wire-change diagnostics across native adapters | Default cache policy stays off. No credentials, prompts, arguments or hashes are logged. Cache hits depend on provider eligibility. Only default five-minute Anthropic cache pricing is implemented. |
| F06 | Exact semantic extension-tool versions coexist with separate wire/source identities | Shared unversioned permission identity; no implicit latest-version selection, schema migration or versioned builtin overrides. Existing source/generation review still applies. |
| F09 | Installed SDK examples for dirty tracked-file guard, explicitly armed staged-content commit on graceful exit, and merge/conflict handling | Examples run in disposable repositories; no push. Auto-commit is opt-in, approvals bind exact staged content and expected Git parent. Hard-crash exit cannot commit. |
| F10 | Fixed Git/PR and third-party indexer diagnostic categories | Literal recognized commands only; no shell execution for classification, no command text/paths retained. Existing telemetry opt-in/disable controls apply. |
| F11 | Private persistent incremental workspace symbol/reference index with cross-file queries | Explicit file sets, reviewed LSP or structured Tree-sitter captures; current content hashes and policy exclude stale/denied files. Bounded references require LSP support. No-history uses memory only. |
| F12 | Explicit image-omission policy for a bounded HTTP 413 retry | Wire input gets visible omission notices; original attachments remain in session history. Disabled by default. |
| F13 | Explicit partial-output fallback with visible replacement markers | At most one fallback per turn, only eligible provider failures without completed tool calls; both attempts retain usage. Archived events remain audit evidence, while replay shows superseded text. |
| F15 | Named startup-phase timings | Arguments, hardening, installation, configuration, credentials, project, TUI import and renderer. Aggregate timing remains. No-history does not persist diagnostics. |
| F18 | Search-result domain allow/deny filters | Exact hosts and subdomains; IDN normalization, deny precedence, decoded search wrappers, operator/caller intersection and bounded response body. Filtering results does not grant network access. |

## Additional engineering completed after the remaining-work review

These items did not require a product decision and are now implemented:

| Area | Delivered | Bounds |
|---|---|---|
| Worktree pool | Prepare reusable slots; persist one-time assignment through CLI/SDK/model controls | Up to eight prepared slots per fill, 16 owned trees total; dirty/active/changed-policy trees are retained and refused. |
| Agent authoring | Model-assisted description/prompt drafts with explicit model and usage | One bounded no-tool call; disabled plan-only output, no MCP, no overwrites; fingerprint activation stays explicit. |
| Named personas | Config registry, definition defaults, explicit named/inline overrides and resume identity | Normal config/trust precedence; no capability expansion; changed identities/config refuse resume. |
| Child inspection | Nested child listing and paginated retained transcripts | Owned journals, snapshot consistency, visible text/tools only; private reasoning/binary attachments omitted; compaction/history retention still apply. |
| Scheduler autostart | Per-workspace launchd/systemd user service install/start/stop/status/uninstall | Explicit CLI activation; existing finite workers and durable budgets/expiry remain; actual inert lifecycle tested on both hosts. |
| Unix socket relay | Private owned socket to stdin/stdout, real half-close, byte/time limits | macOS/Linux local IPC only; no listener, public relay, credential injection or reconnect. |
| Public docs package | Current guides plus safe navigable links, tables, lists and code | Offline output; deployment remains A08. |

See [feature controls](agent-carryovers.md) for commands, configuration and operational limits.

## Partially delivered or still absent

| ID | Delivered now | What remains and why |
|---|---|---|
| F05 | Reviewed catalog artifact/provenance generator, checksum-preserving ETag refresh, compatible `/v1/models` discovery, checksum-pinned installation of an explicit single runtime executable | An operated vendor pricing feed, recurring review ownership/cadence, and all-runtime package/model installation are not an available service. Real runtime/provider acceptance needs selected distributions and accounts. No generated artifact silently changes bundled prices. |
| F07 | Existing local transactional storage and single-owner remote daemon access retained; storage design documented | Direct multi-host NFS/SMB live persistence remains absent. Existing leases depend on verified local OS locking. No representative NFS/SMB server/mount and second host are available to prove lock loss, stale cache, crash/rename/fsync behavior. Enabling it by removing the filesystem guard would be incorrect. |
| F08 | Independent Git object-store clone with explicit sparse directory projection and clean-tree expansion; retained operation intent | Transparent on-demand kernel projection remains absent. The new workflow materializes Git sparse checkouts and copies local Git objects; it is not FUSE/ProjFS, a partial network clone, or a security boundary. Kernel driver installation, OS target selection and real failure/recovery acceptance are needed for that backend. |
| F14 | Opt-in exact substantial stream-repetition abort and one retry for an empty answer | Proprietary provider/header loop signals and semantic/model-specific “laziness” recovery remain absent. There is no reviewed cross-provider signal contract or representative quality corpus; guessing would retry valid refusals/answers. |
| F16 | Explicit registered-public-client browser S256 PKCE, loopback callback, OS-store tokens, refresh and logout/revocation for a configured compatible provider | Actual tenant/client/provider acceptance is open. No borrowed official-CLI subscription credentials, default ambient CLI chains, or hosted first-party account authority. Providers must support the configured public-client contract and resource API. |
| F17 | Owned Windows sleep-inhibitor process using `SetThreadExecutionState` | Windows whole-agent startup confinement and ARM64 native storage transactions remain absent. The current Windows sandbox helper has shared-account ownership constraints; nested parent/tool boundaries cannot safely be inferred. Pinned native storage uses Windows x64 FFI. Both alternatives require supported native backends and actual-host acceptance. Windows sleep code also awaits a real Windows host. |

See [storage/platform design](storage-platform-boundaries.md) for enforceable boundaries and next implementation gates.

## Engineering limits that are not waiting for permission

The earlier summary grouped too many ordinary engineering limits with external dependencies.
The additional implementation above closes seven of those areas. The following broader comparison
limits still exist; they are not claims that credentials or a user decision alone would complete them:

| Remaining scope | Why it is still partial |
|---|---|
| Full shell grammar and dynamic vendor runtime/settings compatibility | Current parsers/importers deliberately support reviewed structural/literal contracts. Full language/runtime emulation is a separate compatibility implementation with a larger conformance corpus. |
| Root-query background sessions and always-running memory consolidation | Existing background commands/children and explicit memory maintenance work. A second durable root owner or autonomous memory writer still needs ownership, cancellation and recovery integration. |
| Generated periodic child summaries | Live status/output and retained transcript inspection work. Periodic model-generated summaries still need explicit cadence/cost policy and an auxiliary generation lifecycle. |
| Full Vim registers/counts/text objects and full TeX rendering | Native editing and bounded terminal math/diagram rendering remain subsets; complete editor/typesetter parity was not implemented. |
| Model-based malformed-call repair and speculative tools | Existing errors allow normal bounded loop recovery, and suggestions stage prompts. A separate repair request/speculative execution lifecycle is absent. |
| General desktop computer control, unrestricted plugin React, arbitrary DB shell and universal Git abstraction | Current browser contexts, bounded extension UI, session maintenance and owned Git workflows remain the accepted concrete interfaces. The broader interfaces are additional engineering, not external acceptance of existing code. |
| Exact kernel deny-glob semantics, pre-runtime hardening and control of arbitrary external-program transports | Current conservative kernel restrictions and governed native transports remain enforced. These broader guarantees need distinct backend integration; they cannot be obtained by relabeling current controls. |

Not every historical comparison row is an outstanding commitment to reproduce another product in
full. All accepted scope limits and missing behavior remain enumerated in the 416-row private audit.
F07/F08/F17 above remain actual missing backends as well as platform/acceptance dependencies.

## Acceptance and release gates

| Gate | Remaining evidence / required input |
|---|---|
| A01 Windows | Actual Windows x64 NTFS/ACL/reparse/lease, restricted-token/WFP denial, shells/PTY cleanup, OS credential store, managed policy, sleep inhibitor, Scoop and activation. ARM64 requires implementation as well. |
| A02 Android | Actual Android/Termux installation, Android-only gate and runtime/storage/sandbox limitations. No Android host is attached. |
| A03 Isolation | Actual KVM hardware with pinned VM assets; supported backend denial, cancellation and cleanup. Local macOS/Linux and TCG results do not establish KVM or Windows equivalence. |
| A04 Providers/services | Explicit accounts, registered OAuth client/tenant/scopes, selected models and spend ceiling; real MCP/OAuth, integrations, OTLP, proxy/fleet and SSH deployment. No paid calls or external messages were inferred. |
| A05 Clients/devices | Authenticated engine dogfood, installed VS Code, physical terminals/clipboard, real LAN/TLS/mDNS/deep links, microphone permissions/transcription and host sleep behavior. |
| A06 CI | Commit the candidate and obtain remote all-architecture CI. Local ARM64 runs are not committed macOS/Linux x64 or Windows CI. |
| A07 Distribution | Fresh account/VM lifecycle for each advertised channel/platform. Available local release/install gates cover only their named hosts and channels. |
| A08 Publication | Choose candidate version/channel; signing/notarization identities and release destinations; explicit publication instruction. No tag, push, signing or publication has been performed. |

## Decisions and inputs needed from you

1. **Storage product scope:** retain local state plus the existing authenticated remote daemon (recommended),
   or require direct shared NFS/SMB state? For direct sharing, identify server/protocol/mount options,
   host architectures and two disposable clients. A backend still needs implementation and acceptance.
2. **Transparent projection:** accept explicit Git sparse projection, or select a kernel-backed target
   (Linux FUSE, Windows ProjFS, or macOS provider) with an installable/testable host. This is additional backend work.
3. **Authentication and catalogs:** provide authorized public-client registration, issuer endpoints,
   exact resource origin/scopes and tenant; choose supported runtime artifacts and who reviews vendor
   metadata/pricing on what cadence. Tokens belong in OS stores, not documents/chat/config files.
4. **Quality/live-service scope:** select model/provider/service cases and a spend ceiling; provide
   deployed endpoints/test tenants. For semantic laziness recovery, specify examples of unwanted
   behavior and acceptable retry criteria before enabling model-specific heuristics.
5. **Platform/device access:** supply the actual Windows, Android, KVM and physical terminal/device
   environments required by A01–A05, or keep those claims experimental/unsupported.
6. **Release:** commit the reviewed changes; choose candidate version/channel and signing/publication
   configuration, then explicitly authorize publication. Remote CI can then evaluate that exact commit.
7. **Deferred products:** D01 realtime voice, D02 packaged desktop/mobile and D03 hosted platform remain
   the recorded no-go decisions. No new decision is needed unless you want to reopen them.

D03 still includes account authority/billing, shared account history/settings/connectors, machine
enrollment, hosted jobs/environments, remote consent/out-of-band approvals, shared ACL-aware team
memory, ambient triggers, gateway/subscriptions, hosted hook delivery and publish/export services.
Local implementations do not turn those into a hosted service.

## Validation

Final format/type checks and regression suites: **1,694 passed / 3 Windows-only skips on macOS ARM64**;
**1,692 passed / 5 OS-specific skips on Linux ARM64**, zero failures (1,697 tests each).
The service path fix also passed focused checks and actual launchd/systemd-user lifecycle probes.
Linux includes the real isolated Chromium case. The installed SDK check exercises all 22 examples,
strict consumer types and runtime assets. Compiled release gates include the new carryover smoke.
Retained logs, exact source manifests and artifact hashes are in the private
`docs/private/post-m11-acceptance/` and `docs/private/roadmap-followup-acceptance/` directories. Artifacts are unsigned and unpublished.

The synchronized comparison inventory is **330 implemented / 71 partial / 15 absent** across 416 rows.
Those are source-scope classifications, not a production-readiness percentage. All 109 original
roadmap items and every remaining partial/absent row are retained in the private audit.
