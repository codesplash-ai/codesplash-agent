# CodeSplash engine — M2 tranche 2 (binding spec)

Extends DESIGN.md and DESIGN-M2.md. Same house rules: no new dependencies, contracts-first,
tests for every cap and refusal, `.ts` import extensions, the product is a "harness", format only
your own files, run ONLY your own test files (`bun test tests/...<yours>`), never the full check.

Out of scope for this tranche (explicitly deferred): remote model-catalog refresh (no hosted
endpoint exists), WebSocket provider transport, service tiers, OAuth login flows, TUI settings
panel. Do not build placeholders for them.

## Phases and module ownership (one owner per file per phase)

| Phase | Task | Files owned |
|---|---|---|
| 1 | byok-foundations | `src/engines/codesplash/contracts.ts`, `src/core/config.ts`, `src/core/toml.ts`, `src/engines/codesplash/catalog.ts`, `src/engines/codesplash/providers/anthropic.ts`, `providers/openai.ts`, `src/engines/codesplash/engine.ts`, `src/engines/codesplash/auth.ts` (only if needed), matching tests |
| 2 | loop (cost + resilience) | `src/engines/codesplash/loop.ts`, pricing values inside `providers/anthropic.ts` / `providers/openai.ts` model tables, `tests/engines/codesplash/loop*.test.ts` |
| 2 | web tools | `src/engines/codesplash/tools/web-fetch.ts`, `tools/web-search.ts`, `tools/registry.ts` (import + list lines only), `tests/engines/codesplash/tools-web.test.ts` |
| 2 | resume | `src/core/engine.ts` (one field), `src/core/sessions.ts` (open-existing API if absent), `src/engines/codesplash/transcript.ts`, `src/engines/codesplash/engine.ts` (transcript wiring), `src/engines/codesplash/runner.ts`, matching tests |
| 2 | commands | `src/commands/completions.ts`, `src/commands/stats.ts`, `src/commands/review.ts`, `src/commands/debug-prompt.ts`, `tests/commands/*.test.ts` |
| 2 | tui | `src/tui/codex-session.tsx`, `src/tui/run-codex-session.tsx`, `src/tui/session-picker.tsx` |
| 3 | cli wiring | `src/cli.ts`, `src/doctor.ts`, `README.md`, `CHANGELOG.md`, `src/engines/codesplash/index.ts`, affected CLI tests |
| 4–6 | integrator, reviewers, fixer | as directed |

Phase-2 tasks run in parallel and must not touch each other's files. `engine.ts` is owned by
byok-foundations in phase 1 and by resume in phase 2 — resume rebases on the phase-1 result.

## Phase 1 — BYOK provider config & provider registry

### contracts.ts changes (binding)

- `ProviderId` keeps its `"anthropic" | "openai"` union but now means the **wire protocol**.
- `ModelInfo.provider` becomes `string` — the runtime provider id ("anthropic", "openai", or a
  custom config key). Add `protocol: ProviderId` (which adapter dialect to speak) and optional
  `pricing?: ModelPricing`.
- New: `ModelPricing = { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number }`
  (USD per million tokens; `cachedInputPerMTok` defaults to `inputPerMTok / 10` at use sites).
- New: `ProviderRuntime = { id: string; protocol: ProviderId; displayName: string; keyEnvVar:
  string; requiresKey: boolean; baseUrl?: string; client: ProviderClient }`.
- `ProviderClient.id` stays `ProviderId` (the protocol it speaks).

### config.ts changes (binding)

`AgentConfig` gains:

```toml
[codesplash]
fallbackModel = "gpt-5.1"          # optional model id (validated at use time, not load time)

[providers.ollama]                  # zero or more custom providers; table key = provider id
protocol = "openai"                 # required: anthropic | openai
baseUrl = "http://localhost:11434/v1"   # required for custom providers
displayName = "Ollama"              # optional, default = capitalized id
keyEnvVar = "OLLAMA_API_KEY"        # optional, default = <ID upper, non-alnum → _>_API_KEY
requiresKey = false                 # optional, default true

[[providers.ollama.models]]         # at least one model required
id = "qwen3:8b"
displayName = "Qwen3 8B"            # optional, default id
contextWindow = 32768               # optional, default 128000
maxOutputTokens = 8192              # optional, default 16384
supportsReasoning = false           # optional, default false
default = true                      # optional; when absent the first model is the default
[providers.ollama.models.pricing]   # optional
inputPerMTok = 0.0
outputPerMTok = 0.0
```

- Typed as `AgentConfig.codesplash: { fallbackModel?: string }` and
  `AgentConfig.providers: CustomProviderConfig[]` (empty by default). Validation is strict with
  aggregated errors in the existing style; provider ids must match `/^[a-z][a-z0-9-]{0,31}$/` and
  must not be `anthropic`/`openai`; duplicate model ids across the whole config are an error.
  **API keys never live in config.toml** — a `key`/`apiKey` field inside `[providers.*]` is a
  validation error with a message pointing at the env var.
- `saveConfig` must round-trip `[codesplash]` and every `[providers.*]` table (a theme toggle
  must not drop them). Extend `stringifyToml` for nested tables/arrays-of-tables if it lacks
  support; keep it minimal and tested.
- New: `applyConfigOverrides(parsed: unknown, overrides: readonly string[]): unknown` — each
  override is `dotted.path=value`; value parsed as a TOML scalar (`Bun.TOML.parse("v = " + value)`)
  falling back to the raw string; applied to the parsed TOML object BEFORE `validateConfig`.
  Malformed overrides (no `=`, empty path) throw with the offending override named (never echo
  values that look like secrets — reuse redactSensitiveText on the message).

### catalog.ts changes (binding)

Replace the static-only surface with a registry (keep thin static exports where existing callers
need them):

```ts
export type ProviderRegistry = {
  providers: ProviderRuntime[]                  // available ones only, built-ins first
  models: ModelInfo[]                           // across available providers
  defaultModel(): ModelInfo                     // anthropic > openai > first custom
  find(id: string): ModelInfo | undefined
  runtimeFor(model: ModelInfo): ProviderRuntime
  parseSelector(selector: string): ModelSelection   // id or id:<low|medium|high>
}
export function buildProviderRegistry(config: AgentConfig, env?: NodeJS.ProcessEnv): ProviderRegistry
```

- Built-in availability: API key resolvable (env or credential store, as today). Custom
  availability: `requiresKey === false` or `env[keyEnvVar]` set.
- Adapter factories gain options: `createAnthropicProvider(options?: { baseUrl?: string;
  keyEnvVar?: string; models?: ModelInfo[] })`, same for openai. Base-URL/key resolution order:
  explicit option > existing env override (`ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`) > default.
  Custom providers construct the adapter for their protocol with their baseUrl/keyEnvVar/models.
  A custom provider with `requiresKey false` and no key env sends no auth header.
- `parseModelSelector` stays exported (built-in catalog only) for compatibility, but engine paths
  go through the registry.

### engine.ts (phase-1 scope)

- `CodesplashDriverOptions` gains `config?: AgentConfig`. The driver builds the registry from the
  provided config, or lazily loads config (via `loadConfig`) the first time probe/openSession
  needs it. `CodesplashSession` keys its provider map by **runtime id** (string), not protocol.
- probe(): built-ins report as today; add one detail fragment per configured custom provider:
  `"<displayName> (custom, key present|no key needed|key missing)"`. Key values never appear.
- CLI/TUI call sites keep working: openSession with no config behaves exactly as today.

Tests: registry building (built-ins only, custom openai-protocol, requiresKey false), config
validation errors (bad protocol, missing baseUrl, key-in-config refusal, duplicate model ids),
saveConfig round-trip with providers, applyConfigOverrides scalars + bad input, adapter factory
baseUrl/keyEnvVar override (assert the fetch URL/header against a Bun.serve fixture).

## Phase 2 — loop: cost accounting + provider resilience

### Cost accounting

- Fill `pricing` on every built-in model (USD/MTok, catalog **estimates**, kept in the model
  tables in providers/anthropic.ts and providers/openai.ts):
  claude-fable-5 15/75, claude-opus-5 15/75, claude-sonnet-5 3/15, claude-haiku-4-5 1/5,
  gpt-5.1 1.25/10, gpt-5.1-mini 0.25/2. `cachedInputPerMTok` = inputPerMTok/10.
- The loop accumulates **session-cumulative** usage: sum inputTokens/cachedInputTokens/
  outputTokens across every provider request in the session, and computes cumulative
  `estimatedCostUsd = Σ (input−cached)·in + cached·cachedIn + output·out` per MTok (models
  without pricing contribute 0 and set a `#hasUnpricedUsage` flag — when set, the cost is still
  emitted but the /usage surface labels it "partial"). Every `usage.updated` event now carries
  cumulative inputTokens/outputTokens plus `estimatedCostUsd` (field already exists in the event
  payload) and keeps `contextTokens`/`modelContextWindow` semantics unchanged.
- Anthropic cached tokens: `cachedInputTokens` are a subset of input priced at the cached rate
  (the openai adapter already reports non-cached input after M1's double-count fix — do not
  re-subtract).

### Doom-loop detection

Track consecutive identical tool calls within a turn: identical = same tool name + canonical
JSON of input (sorted keys). The 3rd consecutive identical call is NOT executed — it returns a
synthetic isError tool_result: "This exact call was already made twice with the same result.
Change your approach instead of repeating it." A 5th consecutive identical call ends the turn
like the round cap does (warning event "Repeated tool-call loop detected; ending the turn" +
forced end). Any different call resets the counter. Declined/failed calls count toward the
sequence (they are how loops usually manifest).

### Turn-start / round-start model fallback

- Config `[codesplash].fallbackModel` (resolved through the registry at send time; unknown or
  unavailable → warning event once per session, then ignored).
- Trigger: a provider stream attempt fails (ProviderHttpError after withRetries exhaustion, any
  status, or a network TypeError) with **zero events emitted for that request**, and a fallback
  is configured, differs from the current model, and its provider is available.
- Action: emit a warning event `"Provider error on <model>; falling back to <fallback>"`, strip
  every `thinking`/`redacted_thinking` block from the in-memory history (signatures are
  model-bound), and retry that request once on the fallback model. The remainder of the turn
  runs on the fallback; the next turn returns to the session's selected model. At most one
  fallback per turn; a fallback failure surfaces the original error path unchanged.
- The loop needs the registry (or a `resolveModel(id)` callback) injected via its constructor
  options; keep the injection minimal and typed in loop.ts.

### History seeding (contract for the resume task)

`CodesplashLoop` gains two members the resume task builds against — implement them here:
- `seedHistory(messages: ChatMessage[]): void` — replaces the loop's history; only legal while no
  turn is active.
- `historySnapshot(): ChatMessage[]` — the current history (same array shape sent to providers,
  thinking blocks included).

Tests: cumulative usage + cost math (multi-request turn, cached tokens, unpriced model), doom
loop (3rd synthetic error, 5th forced end, reset on a different call), fallback (zero-event
failure falls back once, post-first-event failure does not, thinking blocks stripped, next turn
reverts), seedHistory/historySnapshot round-trip.

## Phase 2 — web tools

Both tools: `isReadOnly` true. Permission: `none` under on-request and danger-full-access;
`approval` under untrusted (web_fetch sessionKey `web:<host>`, web_search sessionKey
`web-search`). Allowed under the read-only sandbox (network reads mutate nothing). Output goes
through `truncateToolOutput`. Errors are isError results, never throws (ToolInputError for bad
input only).

### `tools/web-fetch.ts` (`web_fetch`)

- Input: `{ url: string, timeoutSeconds?: number }` (default 10, max 30). http/https only.
- SSRF guard: resolve the hostname (node:dns promises, all addresses); refuse when ANY resolved
  address is loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10),
  unique-local (fc00::/7), unspecified, or ::1 — clear isError naming the blocked class, never
  the resolved IP list. Literal IP hosts get the same check without DNS.
- Redirects: manual, max 5 hops, EVERY hop re-validated by the SSRF guard.
- Response: stream with a 5MB cap (abort past it, isError). `text/html` → minimal in-repo
  markdown conversion (drop script/style/noscript/head, decode entities, map h1–h6/p/li/blockquote,
  `a` → `text (href)`, pre/code fenced). Other `text/*` and JSON pass through raw. Anything else
  → isError naming the content type. Label = the URL.
- Cache: per-tool-instance Map, TTL 15 minutes, max 50 entries, only 2xx text results cached.

### `tools/web-search.ts` (`web_search`)

- Input: `{ query: string, count?: number }` (default 5, max 10).
- Backend: DuckDuckGo HTML endpoint (`https://html.duckduckgo.com/html/?q=...`), a plain fetch
  with a desktop User-Agent, 10s timeout. Parse result anchors + snippets tolerantly (decode the
  `uddg` redirect parameter to the real URL). Any non-200, block page, or parse yielding zero
  anchors → isError "The search backend is unavailable right now; try web_fetch with a known
  URL." — never a throw. Result text: numbered `title — url` lines each followed by an indented
  snippet.
- Register both in `builtinTools()` after `grep` (web_fetch then web_search); descriptions tell
  the model to prefer web_fetch when it already has a URL.

Tests run against local `Bun.serve` fixtures (HTML page, redirect chain, oversized body, DDG-
shaped HTML) with the SSRF guard's resolver injectable; assert private-address refusal without
real DNS.

## Phase 2 — resume & headless continuity

- `src/core/engine.ts`: `OpenSessionOptions` gains
  `nativeTranscriptPath?: string` — a file path where an engine that owns its transcript may
  persist and reload provider-native history. Only the codesplash engine uses it today.
- `src/engines/codesplash/transcript.ts`:
  `loadTranscript(path): Promise<ChatMessage[]>` and
  `appendTranscriptMessages(path, messages: ChatMessage[]): Promise<void>` — JSONL, one
  `{ v: 1, message }` per line, parent dirs created, torn/corrupt lines skipped on load with the
  same healing posture as sessions.ts (a torn final line is dropped; append stays valid). No
  size cap (the transcript IS the session).
- `engine.ts`: when `nativeTranscriptPath` is set — on open, load the transcript and
  `seedHistory` it into the loop (empty/missing file → fresh session); after every turn ends,
  append the messages the turn added (diff `historySnapshot()` length against the pre-turn
  length). `CODESPLASH_CAPABILITIES.resume` becomes `true`. Transcript write failures degrade to
  a single warning event, never a crash.
- `src/core/sessions.ts`: add an open-existing API if absent —
  `store.open(projectId, localSessionId)` returning the same handle shape `create` returns,
  appending to the existing events.jsonl and updating meta on close; plus a
  `transcriptPathFor(handle)` (or equivalent) so callers place `transcript.jsonl` next to
  `events.jsonl`.
- `runner.ts`:
  - `HeadlessRunOptions` gains `nativeTranscriptPath?: string` and `firstSequence?: number`,
    passed through to openSession.
  - The `json` result object and the final `stream-json` result line gain
    `sessionId` (the localSessionId) and `estimatedCostUsd` inside `usage` when observed.
- CLI semantics (implemented by the phase-3 wiring, but the parsing contract is fixed here):
  `codesplash run --resume <localSessionId>` and `codesplash run --continue` (most recently
  updated codesplash-engine session for the project; error exit 2 when none exists; the two
  flags conflict with each other). Resumed runs reuse the session's recorded sandbox/approval
  policy unless overridden on the command line, append to the same session (firstSequence =
  lastSequence + 1), and require history (`--no-history` with resume is a usage error).

Tests: transcript round-trip incl. torn line, engine resume seeding (scripted provider asserts
the request contains the seeded history), append-per-turn, runner sessionId/cost in both JSON
formats, store.open append + meta update.

## Phase 2 — commands (modules only; no cli.ts edits)

Each module exports a pure `parse<X>Arguments(args)` and an effectful `run<X>Command(args,
overrides)` following the existing seams pattern in cli.ts (injectable env/stdout/stderr/store).
Usage errors are `UsageError` (import from cli.ts is a cycle — move/re-export `UsageError` from
a tiny `src/commands/usage-error.ts` and have cli.ts re-export it in phase 3).

- `completions.ts`: `codesplash completions <bash|zsh|fish|powershell>` prints a static
  completion script covering: subcommands (login logout run review stats completions debug),
  root flags, run/review flags, `--sandbox` value completion. Unknown shell → usage error.
- `stats.ts`: `codesplash stats [--days N] [--json]` (N default 30, positive integer). Scans the
  session store across projects: for each session updated within the window, take the LAST
  `usage.updated` event (they are cumulative) and the session meta. Aggregate per engine+model:
  sessions, inputTokens, outputTokens, estimatedCostUsd. Human table on stdout (aligned columns,
  totals row) or `--json` array. Missing/corrupt session files are skipped, never fatal.
- `review.ts`: `codesplash review [path] [--uncommitted | --base <ref> | --commit <sha>]
  [--model <selector>] [--output-format text|json] [--auto]` (default --uncommitted; the three
  modes are mutually exclusive). Collect the diff via git: uncommitted = `git diff HEAD` plus
  untracked files via `git status --porcelain`; base = `git diff <ref>...HEAD`; commit =
  `git show --patch <sha>`. Empty diff → "Nothing to review." exit 0. Diff capped at 200KB with
  a truncation note. Build a reviewer prompt: senior-reviewer rubric, findings as
  `severity (critical|major|minor) · file:line · one-line claim · why it fails`, explicit
  instruction to READ the surrounding source with the tools before asserting, report "No
  findings." when clean. Run through `runHeadless` with policy `{ sandbox: "read-only",
  approvalPolicy: "on-request" }` and the chosen output format; exit code is the runner's.
- `debug-prompt.ts`: `codesplash debug prompt [path] [--model <selector>] [--sandbox <mode>]`
  prints one JSON object `{ model, system, tools: [{name, description, inputSchema}] }` — the
  model-visible surface — built via buildSystemPrompt + the registry. No network, no session.

## Phase 2 — TUI

- `/usage` slash command + overlay: session token usage (input/output/total), context left,
  estimated cost (labelled "estimated" and "partial" when the loop flagged unpriced usage),
  current model, rate-limit line when known. Follows the existing overlay pattern (/model,
  /permissions); add to the slash union, help text, and F1 reference.
- Codesplash session resume: session-picker rows for engine "codesplash" become resumable
  (capabilities.resume is now true). The resume flow replays the local event log exactly like
  the codex path but skips provider-thread reconciliation entirely, and opens the engine session
  with `nativeTranscriptPath` + `firstSequence` (transcript path obtained from the session
  store). Ctrl+R reconnect for codesplash sessions goes through the same path.

## Phase 3 — CLI wiring

- cli.ts: register `review`, `stats`, `completions`, `debug` subcommands; add to run:
  `--resume <id>` / `--continue` / `--effort <low|medium|high>`; add the repeatable
  `-c/--config key=value` override flag to the root TUI command, run, review, and debug prompt —
  parsed overrides feed `applyConfigOverrides` before validateConfig everywhere config is
  loaded. Help text covers everything new; usage errors exit 2. Re-export UsageError from
  commands/usage-error.ts so existing imports keep working.
- doctor.ts: add custom-provider lines from the registry (never key values) and the transcript
  path presence for the newest codesplash session (one line, best effort).
- README: extend the "Native engine" section — BYOK/custom providers (incl. an Ollama example),
  web tools note, `run --continue/--resume`, `review`, `stats`, `completions`, `-c` overrides.
- CHANGELOG: bullets under Unreleased for every user-visible addition.
- index.ts barrel: export the new public modules (registry, transcript, web tools).

## Acceptance

`bun run check` fully green (biome + tsc + entire suite); no new dependencies; Codex/Claude
engine behavior untouched; keys never in argv, logs, errors, doctor output, or test snapshots.
