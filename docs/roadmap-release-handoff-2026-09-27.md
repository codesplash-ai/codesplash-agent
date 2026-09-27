# Roadmap completion and release handoff — 2026-09-27

This document preserves the exact status update requested by the owner, followed by a production release runbook and release outcome. The snapshot is historical: its statement that follow-up changes were uncommitted was true when written. The owner subsequently committed those changes as `ce99219`. Absolute workspace links and the private audit reference below are preserved verbatim; use [the public status document](agent-roadmap-status.md) and [feature controls](agent-carryovers.md) from other machines. Private acceptance evidence is intentionally excluded from the repository and packages.

## Exact status update before release

The original roadmap runs from **M0 through M11: 109 roadmap items**. There are no original M12–M14 phases.

We have implemented the native agent across all twelve milestones, plus substantial follow-up work. **There is still unfinished engineering, platform/service validation, and release work.** Some broader product ideas were explicitly deferred.

The detailed comparison inventory currently records **330 implemented, 71 partial, and 15 absent features across 416 rows**. Those are scope classifications—not a production-readiness percentage.

**M11 is committed. The subsequent implementation and documentation changes are still uncommitted.**

The authoritative records are the [current status document](/Users/kp/Workspace/codesplash-agent/docs/agent-roadmap-status.md) and the [complete item-by-item audit](/Users/kp/Workspace/codesplash-agent/docs/private/agent-roadmap-status-2026-09-27.md).

**Everything delivered since the beginning**

The list below covers all 109 original roadmap items, grouping related capabilities. Where an implementation has a limited scope or still needs acceptance, that is explained afterward.

| Milestone | Delivered capabilities |
|---|---|
| **M0 — Foundation and release housekeeping** | Removed the obsolete fork capability flag; wired image input end to end; corrected reported client versions; relaxed the exact Codex CLI version pin; integrated the Scoop manifest into release tooling; backfilled the changelog and added release-note checks; added PR/push CI workflows. |
| **M1 — Native agent engine** | Streaming provider clients, retries and multiple API protocols; native authentication and credential storage; agent loop and turn state machine; tool registry, schemas and output budgets; coding tools; project rules and system-prompt assembly; planning, todos and user questions; reasoning-effort controls; per-turn diffs; parallel tool execution. Follow-up work added opt-in early execution of fully parsed read-only calls. |
| **M2 — CLI and providers** | Headless execution; stream-JSON input/output; schema-constrained output; launcher and permission flags; resume/continue; shell completions, debug and configuration overrides; noninteractive code review; BYOK providers, model catalogs and local-runtime integration; web fetch/search; token and cost reporting; provider fallback, loop detection, tiers and WebSocket support. Later additions expanded launch inputs, session selection, catalog tooling, domain filters and bounded fallback behavior. |
| **M3 — Permissions and isolation** | Permission modes, rules and editor; structural shell-command analysis; remembered grants and bypass mode; dangerous-command restrictions, path scoping and self-protection; workspace trust; native sandbox/escalation paths; environment filtering, runtime pinning, wrappers, logging and secret handling; guardian classification and repeated-loop protection; plan mode. macOS/Linux isolation has actual denial-test evidence. |
| **M4 — Context, rules and memory** | Context compaction; cache-aware prompt construction; reviewed rules/settings imports and migration; cross-session memory storage, retrieval and explicit consolidation; file mentions and fuzzy search; context inspection and reminders; prompt templates/custom slash commands; skills; model-family prompts and personality choices. Follow-up work added explicit Anthropic cache placement, cache-write accounting and privacy-preserving cache diagnostics. |
| **M5 — Sessions and persistence** | Transactional local SQLite storage and maintenance; session search, organization and lifecycle; mid-turn message queueing and steering; fork, rewind and backtrack; file checkpoints and guarded restoration; session export/import and CLI; input history and draft stash; session information, recaps and telemetry; session trees, supported foreign-session imports and working-directory switching. |
| **M6 — Integrations, extensions and SDK** | MCP client and management CLI; OAuth, approvals, resources, elicitation and liveness; lifecycle hooks, external handlers, gates and rewrites; deferred tool discovery; plugins, marketplaces and hot reload; extension tools/provider/auth APIs and bounded UI; embedding SDK; layered configuration, profiles and provenance. The SDK now has **22 installed examples**, including Git dirty-state protection, explicitly armed exit commits and merge/conflict handling. Exact semantic versions of extension tools can coexist. |
| **M7 — Agent orchestration** | Scoped child agents and definitions; background commands/children and task monitoring; PTYs, stdin, reviewed shell-state replay and shell passthrough; serialized edits and file watching; child budgets, resume and hooks; peer messaging and parallel forks; worktree lifecycle and recovery; goal mode and durable workflows; scheduled/triggered execution; teams, coordinator, dashboard and topology. Follow-up work added prepared worktree pools, model-assisted agent drafts, named personas, nested child transcript inspection and launchd/systemd user services. |
| **M8 — Terminal experience** | Command palette and external editor; remappable keys and native Vim subset; themes, terminal rendering, bounded diagrams/math and image adapters; notifications, status and titles; terminal adaptation, mouse and clipboard routing; inline scrollback mode; settings, onboarding, docs and tips; side questions, away recaps and prompt suggestions; integration management UI; command-backed dictation; motion controls, sleep inhibition and pets. Windows sleep-inhibition code was added later. |
| **M9 — Servers and clients** | Machine protocol server and generated types; daemon, attach and multi-client synchronization; ACP and agent-as-MCP; VS Code extension, pickers and file hyperlinks; LSP/navigation/formatters; web client, remote terminal control and mDNS; authenticated sharing/revocation; GitHub, GitLab, Slack, CI and PR-import integrations; explicit local deep-link handling. Follow-up work added a persistent incremental workspace symbol/reference index. |
| **M10 — Tools and observability** | Structured logs, timings and loop diagnostics; OpenTelemetry and opt-in analytics; feedback/crash/trace summaries; evaluation and fault-injection harnesses; scoped Git utilities and attribution; governed browser, image/PDF, search, clock and remote-execution tools; tool presets, versioning and bundled runtime assets. Later additions included startup-phase timings and content-free Git/PR/indexer diagnostic categories. |
| **M11 — Enterprise and distribution** | Signed update verification/staging, channels, pinning, migration, recovery and rollback; managed/fleet policies and lockdown; cloud/workload/device credentials and OS stores; feature flags, kill switches, signed settings and announcements; experimental Windows x64 support; macOS/Linux whole-agent startup isolation, Linux resource limits and an actual QEMU guest path; native HTTP/WebSocket proxy, CA, offline, deadline and egress controls; branding and distribution extras. Follow-up work added registered-client browser PKCE authentication, a private Unix socket relay and updated offline documentation packages. The hosted-platform exploration concluded with a recorded no-go. |

The latest follow-up implementations also include:

- Positional, seeded and piped prompts; explicit file attachments; project-scoped session selection by ID, title or search.
- An opt-in image-omission retry for oversized requests, preserving original session attachments.
- An opt-in partial-output fallback that visibly marks replaced output and retains usage accounting.
- Reviewed catalog generation/refresh, compatible model discovery and checksum-pinned installation of a selected runtime executable.
- Independent Git object-store clones with explicit sparse directory projection.

Commands and configuration are documented in the [feature controls guide](/Users/kp/Workspace/codesplash-agent/docs/agent-carryovers.md).

**Remaining feature implementation and why**

These are the main unfinished feature workstreams. Several require **both additional code and external acceptance**; supplying an account or machine would not magically complete them.

| Remaining work | What exists | Why it remains |
|---|---|---|
| **Operated model/pricing catalog and broader runtime installation** | Review/provenance tooling, checksum-preserving refresh, model discovery and a pinned single-executable installer. | A maintained vendor feed needs sources, review ownership and cadence. Broader archive/package/model installation needs additional implementations and selected distributions. |
| **Direct shared NFS/SMB session storage** | Local transactional storage and remote access through a single-owner daemon. | A distributed ownership/fencing and durability backend is missing. It also needs representative servers, mount configurations and two-host failure testing. |
| **Transparent on-demand filesystem projection** | Explicit Git sparse projection and clean-tree expansion. | FUSE/ProjFS/macOS-provider backends are missing. Each needs driver integration, copy-on-write/recovery behavior and actual-host testing. |
| **Semantic/model-specific loop or “laziness” recovery** | Exact repetition detection, completed-tool loop bounds and one empty-answer retry. | There is no reviewed provider signal contract or quality corpus distinguishing a bad answer from a valid refusal or concise answer. The semantic recovery implementation remains absent. |
| **Live registered-client authentication acceptance** | Browser S256 PKCE, loopback callback, OS-stored tokens, refresh and revocation for compatible configured providers. | Real client registration, tenant, scopes and resource API acceptance remain. First-party hosted account authority and borrowed official-CLI subscription credentials are outside the delivered implementation. |
| **Windows whole-agent confinement and ARM64 native storage** | Experimental x64 sandbox/storage/policy paths and sleep-inhibition code. | Supported native backends are missing for these two capabilities. The existing helper’s ownership constraints cannot safely establish nested whole-agent/tool confinement. Real Windows acceptance is also outstanding. |

**Additional engineering limits—not waiting for your permission**

These remain incomplete or intentionally narrower than the historical comparison products. They should not have been presented as if every one required a decision from you.

| Area | Remaining scope and reason |
|---|---|
| **Shell and vendor compatibility** | Full shell grammar/canonicalization, automatic reproduction of all shell startup state, and dynamic vendor settings/rules/skills/plugin semantics. Current implementations support reviewed structural or literal subsets; broader compatibility needs its own implementation and conformance tests. |
| **Background execution and memory** | Backgrounding the root model query into another durable session owner, and autonomous continuous memory consolidation. These require ownership, cancellation, persistence and recovery integration. |
| **Child progress summaries** | Periodic model-generated summaries. Live output/status and retained transcript inspection exist; summary generation still needs a bounded lifecycle and cadence/cost controls. Retained transcripts can also be compacted. |
| **Editing and rendering parity** | Full Vim registers/counts/text objects and full TeX rendering. Current native editor and terminal renderer implement subsets. |
| **Additional model execution paths** | A separate model-based malformed-tool-call repair service and speculative tool execution. Existing error recovery and staged prompt suggestions do not implement these lifecycles. |
| **Broader tool/extension interfaces** | General OS desktop control, unrestricted plugin React rendering and an arbitrary database shell. Delivered interfaces are owned browser contexts, bounded panels/forms and session maintenance. |
| **Git depth** | A universal hardened Git abstraction and exact provenance beyond time-window hunk attribution. Current protections cover the implemented workflows. |
| **Protocol/import breadth** | Additional foreign-session schemas, MCP/ACP content forms and arbitrary workflow source-language emulation. Supported native/literal contracts remain bounded. |
| **Personality parity** | Arbitrary vendor personality behavior. Shipped personality choices, model-family prompts and named child personas exist. |
| **Diagnostics** | Full crash dumps and tool-execution replay. Delivered diagnostics intentionally provide content-free summaries. |
| **Isolation guarantees** | Exact kernel deny-glob matching and hardening before runtime entry. Current restrictions conservatively deny broader parent paths, and process hardening begins after runtime entry. |
| **Networking guarantees** | Governing every external program’s transport, operating an agent-owned TLS interception authority and a general network circuit breaker. Native transport controls, administrator proxy support and bounded per-origin upload breakers exist. |
| **Scheduler breadth** | General cron-language support, root-daemon/Linux-linger setup and hosted triggers. Current scheduling uses bounded recurring workers and user services; logout/reboot acceptance remains. |
| **Intentional control boundaries** | Arbitrary executable configuration campaigns and blindly injecting watched-file contents as instructions are not implemented. Signed inert settings and fixed reviewed file-change prompts are the supported behavior. |
| **Operator-specific packaging** | Fork package/channel configuration and public docs/stats deployment remain. The branding and offline build machinery already exist. |

Not every comparison limitation is an outstanding commitment to reproduce another product completely. The audit retains them so that “implemented” does not conceal these boundaries.

**Remaining acceptance and release work**

This is validation or delivery work for existing implementations, except where missing backends are explicitly identified above.

| Gate | What remains and why |
|---|---|
| **A01 — Windows** | Actual x64 testing of NTFS/ACL/reparse/lease behavior, sandbox/network denials, shells/PTY cleanup, credentials, managed policy, sleep inhibition, Scoop and activation. No actual Windows acceptance evidence yet; ARM64 additionally needs code. |
| **A02 — Android/Termux** | Actual installation and runtime/storage/isolation assessment on Android. Documentation and an Android-only gate do not establish support. |
| **A03 — KVM isolation** | Hardware-backed KVM denial, cancellation and cleanup tests with pinned assets. Successful QEMU TCG testing does not prove KVM behavior. |
| **A04 — Providers and services** | Selected live providers/models, registered OAuth tenants, MCP services, integrations, OTLP, proxies/fleet configuration and deployed SSH targets. These need authorized environments and, where applicable, a spending limit. |
| **A05 — Clients and physical devices** | Authenticated engine use, installed VS Code, physical terminal graphics/clipboard/mouse, LAN/TLS/mDNS/deep links, live microphone permissions and sleep/logout/reboot behavior. Protocol tests and local fixtures cover only part of this. |
| **A06 — Remote CI** | Commit the candidate and run the architecture/platform CI matrix against that exact commit. Local ARM64 results do not establish x64 or Windows acceptance. |
| **A07 — Distribution lifecycle** | Fresh-account/machine installation, update and rollback for every advertised platform/channel. Existing local tests cover only their named environments. |
| **A08 — Publication** | Release version/channel, signing/notarization configuration, destinations and publication authorization. Release artifacts are unsigned and unpublished; the public docs/stats site is not deployed. |

Recorded validation for the current implementation is **1,694 passing tests on macOS ARM64 and 1,692 on Linux ARM64, with zero failures**; the remaining tests were OS-specific skips. The installed SDK checks cover all 22 examples. Actual inert launchd/systemd service lifecycle probes also passed. These results do not close the external gates above.

**Deferred products and why**

These are recorded no-go/deferred scope decisions, rather than unfinished local features:

- **D01 — Realtime voice conversation.** Dictation exists; a continuous realtime voice product does not.
- **D02 — Packaged desktop/mobile companion.** Local deep-link handling exists; packaged applications and mobile handoff do not.
- **D03 — Hosted CodeSplash platform.** This includes account authority, billing/subscriptions and account usage APIs; machine enrollment and hosted remote bridges; cloud tasks/reviews/plans and environment provisioning; cross-device history/settings/connectors/skills/agents; account-backed connector discovery; ACL-aware shared team memory; hosted consent/approvals; ambient triggers; hosted gateways; server-side hook forwarding; and hosted publish/deploy/GitHub-export services.

D03 requires a separate hosted backend, identity model and operations program. The local daemon, integrations and orchestration features do not supply those services.

**Your decisions and inputs**

These are the specific choices needed from you, separate from the ordinary engineering backlog:

1. **Storage scope:** Is local storage plus the authenticated remote daemon sufficient, or must we support direct shared NFS/SMB state? I recommend retaining local storage plus the daemon. Direct sharing would require a new backend and representative multi-host environments.

2. **Projection scope:** Is explicit Git sparse projection sufficient, or do you require transparent on-demand files? If required, select the first target: Linux FUSE, Windows ProjFS or a macOS provider.

3. **Supported platforms:** Which platforms must be supported for the next release? Windows, Android and KVM need actual environments before their support claims can advance; Windows ARM64 and whole-agent confinement additionally need implementation.

4. **Authentication acceptance:** Select the provider/tenant and authorized public-client registration, resource origin and scopes to validate. Credentials should be configured through the OS credential store.

5. **Catalog/runtime operations:** Choose supported runtime distributions and catalog/pricing sources, plus who owns recurring metadata review.

6. **Live quality and integration testing:** Choose the models/services and spending ceiling. For semantic recovery, provide representative unwanted behavior and acceptable retry criteria.

7. **Release and deployment:** Choose the candidate version/channel, signing/notarization setup and release/docs destinations. The current follow-up changes need review and commit; publication needs your explicit instruction.

8. **Deferred products:** No new decision is needed to preserve the existing no-go decisions. Explicitly reopen realtime voice, desktop/mobile or the hosted platform only if you want those added to the product scope.

## Production deployment runbook

The owner committed the implementation as `ce99219` and explicitly authorized deployment to npm, Homebrew and GitHub Releases. The selected release is **0.2.0**, a minor feature release after 0.1.4. Use the existing `latest` npm channel, GitHub release repository `codesplash-ai/codesplash-agent`, and Homebrew tap `codesplash-ai/homebrew-tap`. Publication does not promote experimental Windows, Android or KVM support, complete live-provider acceptance, deploy a public website, or create a hosted platform.

### Prepare and validate a candidate

1. Start with a clean, reviewed checkout. Read [the current status](agent-roadmap-status.md), [release checklist](release-checklist.md), and [distribution controls](distribution.md). Preserve explicit platform and feature limits in release notes.
2. Pick an unused semantic version. Update `package.json`, run `bun scripts/sync-version.ts`, and move the accumulated `Unreleased` notes into a dated version section in `CHANGELOG.md`. Do not republish or move an existing release tag.
3. Verify `bun install --frozen-lockfile`, `bun run check`, `bun run build`, `bun scripts/check-changelog.ts`, and `npm pack --dry-run`. Inspect the package allowlist for private records or credentials. Run the release and installed-SDK gates required by the checklist.
4. Commit and push the candidate to `main`. Wait for `.github/workflows/ci.yml` to finish. Review each macOS/Linux architecture, Windows experimental acceptance and the distribution image separately. Fix production failures before publication; do not suppress a failure to manufacture a passing release. A tag may start the release checks alongside CI when the publish job remains gated by every required production build. Experimental platform failures remain explicit and must not promote support claims.

### Publish through the existing workflow

1. Verify the npm package's trusted publisher is GitHub repository `codesplash-ai/codesplash-agent`, workflow `release.yml`. This uses GitHub OIDC; a local npm login or `NPM_TOKEN` is not needed for that path.
2. Verify repository secrets by name, never by printing their contents: `TAP_GITHUB_TOKEN`, `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`. Optional alternate Homebrew/Scoop variables are separate from the primary Homebrew destination.
3. Tag the reviewed candidate and push the tag; publication still requires the workflow’s production checks to pass. For this release:

   ```sh
   git tag -a v0.2.0 -m "CodeSplash Agent v0.2.0"
   git push origin refs/tags/v0.2.0
   ```

4. Watch `.github/workflows/release.yml`. It checks/builds each host target, signs/notarizes configured macOS binaries, runs compiled smoke gates, uploads archives/checksums, creates the GitHub Release, publishes npm with provenance, and updates the Homebrew formula with released checksums.
5. Confirm each channel independently. A partially successful workflow is not a completed deployment. Do not delete/recreate a published npm version or move a release tag to repair a failure. Resume only the missing publication step using the same verified artifacts, or issue a new version if code changes are required.

### Verify the deployed version

```sh
npm view codesplash-agent@0.2.0 version dist.integrity dist.attestations --json
npm view codesplash-agent dist-tags --json
gh release view v0.2.0 --repo codesplash-ai/codesplash-agent
brew update
brew upgrade codesplash-ai/tap/codesplash-agent
codesplash --version
codesplash --doctor
```

For a new installation, use `brew install codesplash-ai/tap/codesplash-agent` or `npm install -g codesplash-agent@0.2.0` (Bun 1.3.14 or newer is required by the npm package). Verify downloaded archives against `SHA256SUMS`, then exercise an extracted binary in a disposable directory. Inspect the tap formula's version and all four platform checksums. Retain workflow URLs, exact tag SHA, package integrity, tap commit and installation results below. Fresh installations and physical-device/live-account acceptance are distinct from publishing.

### Rollback

Retain the prior `0.1.4` artifacts and tap history. For npm, install `codesplash-agent@0.1.4`; an authorized release operator can move `latest` back and deprecate the defective version with a specific reason. Restore the previous Homebrew formula commit through a new revert commit. Download the earlier GitHub archive for standalone rollback. Preserve published versions/tags and diagnostic evidence. Managed minimum-version policy can intentionally refuse an application-level rollback; review it first. Do not delete user session/configuration data.

## Release outcome

**Released 0.2.0 to GitHub Releases, npm `latest`, and Homebrew on 2026-09-27.** This document on `main` is the final deployment record; the immutable package copy retains its build-time state and historical snapshot.

Release preparation exposed and fixed issues that local ARM64 testing had not established:

- Darwin local-filesystem detection now verifies the APFS/HFS name and local-mount flag instead of assuming runtime-assigned numeric type IDs are identical on Intel and ARM64 hosts.
- Windows transactions close rejected native handles, request the metadata and directory access they require, normalize unsigned access masks, and use the correct native relative rename/link information classes.
- The Windows trusted broker retains its own provisioning-state location, while workload profiles remain temporary and provider credentials remain excluded.
- Intel integration tests wait for explicit terminal readiness and bounded completion instead of assuming one- or two-second startup. Test assertions remain in place.
- The distribution image now includes the current roadmap and handoff guides used by its offline docs build.

The [tagged candidate CI run](https://github.com/codesplash-ai/codesplash-agent/actions/runs/36345565268) passed all four complete macOS/Linux production jobs and the distribution image at `37e5f995d0ca72e210966724ac0dd5ea5c72f200`. Both macOS architectures passed 1,694 tests with four Windows-only skips; each Linux architecture passed 1,691 with seven platform/browser-environment skips. Every production target passed the compiled gates and all 22 installed SDK examples. Earlier Intel runs exposed short readiness waits and cancelled streaming-fixture connection reuse; the tests were corrected without removing assertions. Actual Windows x64 storage/reparse/ancestor pinning, PowerShell/cmd, broker-environment checks and WFP network denial passed. Full Windows sandbox execution still refuses when the pinned helper cannot apply ACLs to protected `C:\Windows` and `C:\Program Files` directories. The failure remains visible, cleanup ran, and no isolation rule was removed to make it pass. Windows remains experimental and is not a required production artifact for this release.

The immutable `v0.2.0` tag points to `37e5f995d0ca72e210966724ac0dd5ea5c72f200`. The [release workflow](https://github.com/codesplash-ai/codesplash-agent/actions/runs/36345599470) completed successfully. The first signed Intel attempt passed regression and notarization but hit a one-second terminal smoke readiness race; publication was skipped. The unchanged tagged gate passed on retry before publication. The permanent readiness/output polling fix is committed on `main` as `e4bc266`; it changes the smoke harness, not the shipped runtime. The tag was not moved. This final documentation record is a later commit on `main`.

### Verified publication and installation evidence

| Channel | Final result |
|---|---|
| GitHub Releases | [v0.2.0](https://github.com/codesplash-ai/codesplash-agent/releases/tag/v0.2.0), published 2026-09-27 at 20:19:38 UTC, regular public release; four macOS/Linux archives, four sidecar hashes and `SHA256SUMS`. No Windows artifact. |
| npm | [codesplash-agent 0.2.0](https://www.npmjs.com/package/codesplash-agent/v/0.2.0), `latest: 0.2.0`, public package, GitHub OIDC trusted publishing and [SLSA provenance](https://registry.npmjs.org/-/npm/v1/attestations/codesplash-agent@0.2.0). Initial registry processing briefly returned 404; subsequent fresh-cache lookup and installation succeeded. |
| Homebrew | [Tap commit `15bb5ec`](https://github.com/codesplash-ai/homebrew-tap/commit/15bb5ec5ed46ba05e0fa537b346d70e7dcd581b0), formula version 0.2.0; all four platform hashes match GitHub asset digests and `SHA256SUMS`. |
| macOS signing | Both architectures passed Developer ID signature verification and Apple notarization (`Accepted`) in the release job. The downloaded ARM64 binary also passed local strict signature verification outside the restricted tool sandbox. |
| Actual installation | macOS ARM64 standalone download passed checksum, `--version` and `--doctor`; fresh npm installation in a disposable prefix passed version, diagnostics and the quota-free SDK example; the existing Homebrew installation upgraded to 0.2.0 and `brew test` passed. Homebrew 0.1.4 was retained for rollback. |

npm integrity:

```text
sha512-RyqYTRRkuZLzEKfGp7XMtZGdoff2mS6cgqgfGSFnyMlWj9KJEvah29Eg8MKkQfIq98eDxp5x6F4u2t6x52NwHw==
```

Published archive checksums (also independently matched to GitHub asset digests and the Homebrew formula):

```text
b3545fd64ff02834e50b4aba6674a51ff5825417a125f7225bfb7959aed8fa7a  codesplash-agent-0.2.0-darwin-arm64.tar.gz
cfce70874d9be0cecdbd00bb11139b45d639e131e2f76716fc3929e6dd046c3b  codesplash-agent-0.2.0-darwin-x64.tar.gz
b0ad9848e6cb01c3ce4577e8b2414312ac56b253559b243f0a6a71614055f826  codesplash-agent-0.2.0-linux-arm64.tar.gz
1a5e3a084de8dff2976de8ae28fa1240544c2065346ed12d5afe42354bbf1e56  codesplash-agent-0.2.0-linux-x64.tar.gz
```

Private logs and registry/API evidence are retained locally under `docs/private/0.2.0-release/`; the public workflow and release links above remain usable without those local files. No private evidence or credentials were added to the package allowlist.

### What this release closes and what stays open

- **A06:** remote regression, standalone sandbox and all 22 installed SDK example gates passed on macOS ARM64/x64 and Linux ARM64/x64 for the exact tagged candidate. Candidate CI still reports an overall failure because the explicit experimental Windows gate remains failed; the release workflow succeeded with its existing experimental-platform exclusion.
- **A08:** version/channel choice, owner publication authorization, macOS signing/notarization, GitHub release, npm provenance publication and the primary Homebrew tap update are complete. Public website hosting and an operated standalone signed-update feed are separate, still unconfigured deployments.
- **A07:** actual local macOS installation checks now cover all three channels. This does not establish fresh-account/device upgrade, uninstall and rollback coverage on every advertised architecture. The four-host compiled package gates are additional evidence, not a substitute for those lifecycle probes.
- **A01–A05 and remaining engineering:** retain the specific limits and input requirements above and in [current status](agent-roadmap-status.md). Windows x64 has real partial evidence, but its full sandbox gate remains blocked; Android, KVM, live accounts and physical-device acceptance are not promoted by publication.

## Owner follow-up and decisions after this release

Package publication is authorized and does not need another owner decision. The three requested production channels are complete. Your next operator steps and future product choices are:

- Upgrade through your chosen channel using the commands in the runbook, then run `codesplash --version` and `codesplash --doctor`. Configure provider credentials through the documented credential stores and perform an authenticated smoke in your own workspace.
- Enable scheduler services, fleet policy, integrations and the standalone signed-update feed only where you intend to operate them. Shipping the CLI does not activate those services in customer environments.
- Choose local state plus the remote daemon versus a new direct NFS/SMB backend; choose whether explicit Git sparse projection is sufficient or a specific kernel projection backend is required.
- Select additional supported platforms and supply their real acceptance environments. Windows whole-agent confinement and ARM64 storage still need implementation; Windows x64 execution needs the protected-directory ACL blocker resolved before promotion.
- Supply authorized OAuth registration/tenant/resource scopes, selected live providers and services, a spending ceiling, supported runtime distributions, and a catalog/pricing review owner and cadence.
- Choose public website hosting and an operated signed-update feed only if you want those separate deployments. Realtime voice, packaged companions and the hosted platform stay deferred unless explicitly reopened.

These choices are separate from the ordinary engineering backlog in the snapshot and current status document. The remaining work is not all waiting for your permission.

## When work resumes

1. Start with the release outcome above, then [current roadmap status](agent-roadmap-status.md). The exact snapshot remains historical and must not be edited to imply that later acceptance existed at the time.
2. Address release regressions and actual-user reports first. Reproduce issues against the installed release, preserve data, and issue a new patch version for fixes.
3. Complete remaining platform/device/live-account acceptance only in the corresponding real environments. Record evidence against an exact commit and distinguish acceptance from missing backend implementation.
4. Continue ordinary engineering from the unfinished-scope tables above; those items do not all require owner permission. Root-query background ownership, autonomous memory maintenance, child summaries and broader conformance need substantive design/implementation and meaningful tests.
5. Obtain the explicitly listed product choices before building a direct shared-storage or transparent projection backend, operating catalog services, or broadening supported platform claims. Keep local storage/daemon access and sparse projection as the currently delivered scope.
6. Keep realtime voice, packaged desktop/mobile and the hosted platform deferred unless explicitly reopened. The original roadmap ends at M11; any new phases should be named and scoped deliberately.

No deployment to npm/Homebrew/GitHub automatically configures customer credentials, fleet policy, scheduler services, a signed standalone-update feed, public website hosting or live integrations. Those are separate operator setup tasks documented in the linked guides.
