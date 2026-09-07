# M4 tranche C — durable memory (binding specification)

Implements the reviewed private tranche-C plan on 9ac4321. Baseline: 1,251 macOS tests pass.
Phase-0 probe: FTS5, transactional rollback and Float32 blobs pass in Bun 1.3.14 and standalone
arm64 binaries on macOS/Linux. Exact scans of 2,000 × 1,536 dimensions took 11–13 ms locally.
No new dependency; bun:sqlite plus bounded TypeScript cosine/MMR. One integrator, ordered phases,
source review/fixes then both platform suites and compiled acceptance. General sessions remain M5.

## Ownership and order

1. memory/contracts.ts, identity.ts, store.ts: identities, immutable Markdown and atomic manifests.
2. memory/retrieval.ts, embedding.ts: FTS5, bounded vector index, hybrid ranking and fallback.
3. memory/session.ts, engine/core/controller/config/TUI/CLI: governance, commands, injection.
4. memory/maintenance.ts and recovery: extraction, consolidation, lifecycle and usage.
5. Adversarial/relevance/platform/compiled tests; README/CHANGELOG and private completion evidence.

## Identity and authoritative storage

Data root is dataDirectory()/memory; never model-selected. Canonical git common-dir identifies
linked worktrees, canonical cwd identifies non-Git folders. A deterministic lookup key maps to a
random repository UUID in an application-owned registry. Worktree identity hashes the canonical Git toplevel (cwd for non-Git folders).
Different clones never merge by URL. No Git metadata is written. Explicit `memory link UUID`
previews linking the current location, and --apply writes an alias only when it would not abandon
an existing nonempty store. Existing session ids stay unchanged. New locations create no state on read.

Each repository has manifest.json {version:1, revision, records:{id:filename}, processed:string[]}.
Immutable objects/<uuid>-<revision>.md contain JSON metadata between --- lines and a Markdown body.
Metadata: id, revision, scope (repo/worktree), worktree, kind (fact/candidate/note), source
(user/generated), session id, sources (bounded source ids/text hashes), timestamps and optional
reviewed status. Accepting a candidate preserves its generated source and source references. Canonical records are bounded regular singly-linked files, with no symlink components.
UUIDs and object filenames are strictly validated. Maximum 2,000 records, 4 KiB body, 8 KiB record,
32 source references/record, 256 processed extraction hashes. Notes are scoped to their session.

A writer uses an exclusive per-store lock (pid + nonce, bounded wait). Stale dead-process locks
can be reclaimed with identity checks; live locks are never aged out. Write immutable objects,
fsync, atomically replace the manifest, then remove unreferenced objects/index entries. Manifest
replacement is the commit point; unreferenced crash leftovers are never resurrected by repair.
Revision preconditions reject concurrent stale edits. Deletion physically purges obsolete objects
on success; repair completes leftover garbage cleanup. Corrupt manifests fail explicitly and are
never silently replaced with an empty store. Index corruption cannot destroy canonical records.

index.sqlite is derived, built to a temporary database and atomically renamed after closing;
DELETE journal mode and bounded busy timeout, no runtime extension loading. FTS5 indexes id/body;
vectors include record content hash, embedding key and validated Float32 dimensions. Queries use
read-only handles and compare index/manifest revisions; stale/missing indexes are rebuilt in memory
for reads, never on disk under read-only/plan. Vector cache writes and index repair take the writer
lock. Edits/deletes invalidate matching vectors. Cap embeddings at 1,536 finite dimensions.

## Governance and user controls

[memory]: enabled=true, autoLearn=false; optional embedding {url, model, keyEnvVar, dimensions,
inputPerMTok}. Endpoint is explicit HTTPS, no userinfo/query/fragment; key is an explicit env name,
never a stored config value. Unknown/invalid settings fail validation. Embedding configuration
alone does not waive the native network policy or explicit web_fetch ask/deny rules.

`/remember text` and CLI `memory remember text` create user facts. `/memory`/CLI support
list, show ID, search QUERY, edit ID TEXT, forget ID, accept ID, status, repair, index, refresh, link UUID,
extract and consolidate. Link defaults to preview; --apply is explicit. Writes need trusted,
history-enabled, non-plan workspace-write sessions. CLI uses config/policy/trust flags consistently.
Durable model writes use memory_write with ordinary permission approval and revision checks.
Memory/search/read operations are scoped to the current repository; ids never name host files.
Model recovery and notes tools cannot select other sessions or repositories.

Untrusted and no-history sessions do not read/create/update durable memory or schedule learning.
Session notes may remain in memory. Read-only/plan allow existing memory retrieval but no durable
mutation, indexing or learning. Every call checks current mode/trust. Stored data never executes
@include, templates, shell or permission directives. Redact before storage, indexing, embedding,
logging and injection. Provenance labels remain separate from current rules. Source-path-bound
entries are filtered against current read permissions; unknown generated candidates stay inactive.
Sanitization is conservative best effort, not a guarantee of detecting every sensitive fact.

## Retrieval, embeddings and injection

Keyword FTS5/BM25 works without embeddings. Quote/tokenize user queries rather than accepting
raw FTS syntax. At most 100 candidates, six results/8 KiB injected, stable tie breaking by id.
Optional vectors use cosine, lexical/vector rank fusion and MMR (lambda .7; token overlap works
without vectors). Curated facts outrank equivalent generated observations; generated observations
decay with a 30-day half-life unless explicitly reviewed. Candidates and other-session notes never auto-inject. Expose mode
lexical/hybrid/fallback and reason; do not claim real-model quality from fixture rankings.

Embedding is a hidden governed operation with web_fetch permission semantics and the existing
DNS-pinning network broker. Only explicit config chooses endpoint/model/key. Requests: at most
16 texts/64 KiB, 10 seconds, 512 KiB response. Reject redirects, malformed counts/indexes, nonfinite
or wrong-dimension vectors. Query failures fall back to lexical with an observable reason.
Cache by text hash + endpoint/model/dimensions; index new vectors only in writable sessions.
Search prioritizes lexical matches when caching up to 15 new vectors alongside its query.
Explicit memory index processes up to 16 eligible facts and reports the remainder; only cached
facts participate in semantic ranking. Mutations/repair purge derived state and may require
reindexing. Index absence/corruption has an observable in-memory fallback.
Usage is counted separately from chat when no compatible chat-model price exists; configured
inputPerMTok supplies cost, otherwise label cost unknown. No live metered test calls.

First admitted turn retrieves against user text. Freeze the labelled selection until a store
revision, permission/mode/model change, explicit refresh or context epoch change invalidates it.
Revalidate source permissions before every admission even for cached selections. A's budget admits
the combined prompt. /context exposes memory token contribution and retrieval mode; memory facts
are reference material subordinate to current instructions. No-content stores add no prompt text.

## Learning, notes and history recovery

Extraction is explicit or autoLearn opt-in, never default. Use the currently selected provider
with no tools, 12k input-token cap, at most two requests/maintenance operation, 2,048 output tokens
per request, 60s total. Validate JSON candidate facts against supplied source ids; return at most
16 candidates per response with source hashes. No-new-information output is valid. Candidates need explicit
acceptance before first-turn injection. Consolidation deduplicates/reconciles candidates with
validated source ids; it never overwrites/deletes curated facts. Exact duplicates can be dropped
deterministically. Conflicts remain user-reviewable candidates. Apply against the starting store
revision atomically; malformed output, stale revision, interrupt or storage failure leaves it intact.
Processed source hashes prevent repeated extraction after resume; no worker/tool side effects.

Idle learning is session-owned: one job after a completed turn, bounded as above. New foreground
work cancels and awaits it before admission; close aborts and awaits it; interrupt aborts it and the owned promise settles. No new jobs on
shutdown. No durable daemon/queue outside the session. Cumulative chat usage/cost includes auxiliary
requests and observable failures. Auxiliary usage events must not distort next-request calibration.

Session notes: bounded ids, 16 notes/4 KiB each, explicit notes tool; in-memory in no-history or
read-only mode, durable current-session notes only with write permission. History recovery reads
bounded current native-session evidence (user/assistant messages, no raw tool bodies) via fixed
session locations; maximum 8 MiB input/1,000 items, 20 results/8 KiB output. Explicit history_read
permission approval governs recovery of older evidence; absent recorded evidence falls back to
current in-memory messages. No generic filesystem or cross-repository search interface. M5 owns
full session indexing/navigation/migration and general multi-session history search.

## Acceptance

Repository/worktree/clone/move tests; concurrent revisions/locks; crash before/after manifest
commit, deletion without resurrection, corrupt derived index and repair, denied/symlink/hardlink
paths, read-only/no-history, secret canaries, lexical/semantic relevance and MMR, changed embedding
models/dimensions, bounded/failing network, provenance and prompt injection, candidate conflicts,
no-tools extraction, duplicate suppression, usage/cancellation/send/close/resume. Both native
platform suites and actual compiled memory smokes using local scripted providers. Preserve prior
sandbox/context/input smokes. Remote CI/Intel acceptance remains separately unverified.
