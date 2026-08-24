# CodeSplash native engine — build plan and module contract

The first-party engine lives behind the existing `EngineDriver`/`EngineSession` contract
(`src/core/engine.ts`) and emits the existing 17-kind `AgentEvent` union (`src/core/events.ts`),
so the SessionController, reducer, recorder, and approval UI are reused unchanged. Codex and
Claude Code remain alternate engines.

All shared types are in `contracts.ts`. Modules import ONLY: `contracts.ts`, `../../core/index.ts`,
and node/bun builtins. Modules never import each other; the loop composes them.

## House rules (every module)

- No new dependencies. Use `fetch`, `Bun.spawn`, `Bun.Glob`, `Bun.file`, `node:fs`, `node:path`.
- Match repo style: run `bun run format` before finishing; imports carry `.ts` extensions.
- Every module ships tests under `tests/engines/codesplash/`; run them with
  `bun test tests/engines/codesplash/<file>` (do NOT run the full `bun run check` — sibling
  modules may not exist yet while you work).
- Bounded resources everywhere: caps and timeouts follow the numbers below, and errors are
  returned as values (`isError` results, probe details) rather than thrown across module edges.
- The product is called a "harness" in all copy and comments.

## Module ownership (one builder per row; touch ONLY your files)

| Module | Files (src/engines/codesplash/ + tests/engines/codesplash/) |
|---|---|
| providers/shared | `providers/retry.ts`, `providers/sse.ts` + `retry.test.ts`, `sse.test.ts` |
| providers/anthropic | `providers/anthropic.ts` + `anthropic.test.ts` |
| providers/openai | `providers/openai.ts` + `openai.test.ts` |
| tools/files | `tools/read.ts`, `tools/write.ts`, `tools/edit.ts` + `tools-files.test.ts` |
| tools/search | `tools/glob.ts`, `tools/grep.ts` + `tools-search.test.ts` |
| tools/shell | `tools/bash.ts` + `tools-shell.test.ts` |
| tools/registry | `tools/registry.ts`, `tools/truncate.ts`, `tools/todo.ts`, `tools/question.ts` + `tools-registry.test.ts` |
| prompt | `prompt.ts` + `prompt.test.ts` |
| engine (after all above) | `loop.ts`, `engine.ts`, `catalog.ts` + `loop.test.ts`, `engine.test.ts` |

## Providers

- `providers/retry.ts`: `withRetries<T>(operation, options?: RetryOptions): Promise<T>`.
  Retries ProviderHttpError with status 408/429/5xx and network TypeErrors; honors
  `retryAfterMs` (capped at maxDelayMs, default 30s); exponential backoff with full jitter from
  baseDelayMs (default 500ms); default 5 attempts; aborts promptly on the signal.
- `providers/sse.ts`: `parseSseStream(response: Response, signal?): AsyncIterable<{ event?: string; data: string }>`
  — incremental parser, tolerant of multi-line `data:`, comments, and CRLF; ends cleanly on abort.
- `providers/anthropic.ts`: Messages API (`POST https://api.anthropic.com/v1/messages`,
  `anthropic-version: 2023-06-01`, key from `ANTHROPIC_API_KEY`, overridable base URL via
  `ANTHROPIC_BASE_URL` for tests). Streams SSE; maps content_block deltas to text_delta /
  reasoning_delta (thinking blocks), assembles input_json deltas into complete tool_call events,
  message_delta usage → usage, stop_reason end_turn/tool_use/max_tokens → done. Thinking budget
  by effort: low 4096, medium 12288, high 24576 (when model.supportsReasoning).
- `providers/openai.ts`: Chat Completions API (`POST {OPENAI_BASE_URL|https://api.openai.com}/v1/chat/completions`,
  key from `OPENAI_API_KEY`), `stream: true` with `stream_options: {"include_usage": true}`.
  Maps delta.content → text_delta, accumulates tool_calls fragments into tool_call events on
  finish, finish_reason stop/tool_calls/length → done; `reasoning_effort` passed through when
  supportsReasoning. Tools use the `function` wrapper; ChatMessage tool_result blocks become
  `role:"tool"` messages, tool_call blocks become assistant `tool_calls`.
- Both adapters: non-2xx → ProviderHttpError with status and Retry-After; connection retried via
  withRetries; never retry after the first emitted event; redact nothing (keys never appear in
  errors). Tests run against a local `Bun.serve` fixture streaming recorded SSE (happy path,
  tool-call assembly, 429-then-success, abort mid-stream).

## Tools

Caps: file reads 2000 lines / 50KB per call (offset+limit paging); tool output truncated
head+tail to 2000 lines / 50KB with an elision marker (`tools/truncate.ts` →
`truncateToolOutput(text, options?)`); bash default timeout 120s (max 600s via input), output
capped through truncateToolOutput; grep results capped at 200 matches.

- `tools/read.ts` (`read_file`): path (+optional offset/limit). Read-only. Refuses directories
  and files > 5MB with a clear message.
- `tools/write.ts` (`write_file`): path + content; creates parent dirs; returns bytes written;
  mutatedPaths=[path].
- `tools/edit.ts` (`edit_file`): path + old_string/new_string (+replace_all). Exact match first;
  on failure retries with whitespace-normalized matching; ambiguous or missing → ToolInputError
  listing the closest candidate line. mutatedPaths=[path].
- `tools/glob.ts` (`glob`): pattern via `Bun.Glob`, cwd-relative, ignores `.git` and
  `node_modules`, sorted by mtime desc, capped 500 entries. Read-only.
- `tools/grep.ts` (`grep`): regex content search implemented in TS (walk via Bun.Glob over
  `**/*`, skip `.git`/`node_modules`/binary-looking files > 1MB), flags: -i, glob filter,
  context lines; capped 200 matches. Read-only.
- `tools/bash.ts` (`bash`): `Bun.spawn(["bash","-c",command])` with cwd, timeout kill (SIGKILL
  after grace), merged stdout+stderr through truncateToolOutput, exit code in the result text.
  Never read-only.
- `tools/todo.ts` (`todo_write`): full-list replace; validates unique ids; returns planSteps in
  the outcome. Read-only (no fs side effects).
- `tools/question.ts` (`ask_user`): spec only (question + 2–6 options[]); run() throws — the
  loop executes it (see contracts ASK_USER_TOOL_NAME).
- `tools/registry.ts`: `builtinTools(): HarnessTool[]` (read_file, write_file, edit_file, glob,
  grep, bash, todo_write, ask_user) and `createToolRegistry(tools)` → `{ specs(): ToolSpec[];
  get(name): HarnessTool | undefined }`; duplicate names throw.

### Permission policy (enforced by each tool's `permission()`/`run()`)

| policy | read tools | write_file / edit_file | bash |
|---|---|---|---|
| sandbox read-only | none | ToolInputError (refused) | approval, always |
| workspace-write + on-request | none | inside cwd: none · outside cwd: approval | approval (sessionKey `bash:<argv0>`) |
| workspace-write + untrusted | none | approval | approval (no sessionKey) |
| danger-full-access | none | none | none |

Approval titles/details mirror the Codex driver's ("Run command?" with command+cwd, "Apply file
changes?" with the path).

## Prompt assembly (`prompt.ts`)

- `discoverProjectRules(cwd): Promise<ProjectRulesFile[]>` — AGENTS.md (preferred) or CLAUDE.md
  at each directory from the git repo root (or cwd when not a repo) down to cwd; per-file 24KB
  cap, 48KB total, oldest-ancestor first.
- `buildSystemPrompt(options: SystemPromptOptions): Promise<string>` — concise harness identity
  ("CodeSplash Agent, a coding harness running in a terminal"), working directory, platform,
  date, sandbox/approval policy summary, tool usage guidance (prefer read/edit over bash for
  files; keep edits minimal; no destructive commands without need), then any project rules under
  a "Project instructions" heading with their source paths.

## Engine (`catalog.ts`, `loop.ts`, `engine.ts`) — built after all modules exist

- `catalog.ts`: static ModelInfo lists — anthropic: claude-fable-5 (default, reasoning),
  claude-opus-5 (reasoning), claude-sonnet-5 (reasoning), claude-haiku-4-5-20251001; window
  200000, maxOutput 32000. openai: gpt-5.1 (default, reasoning), gpt-5.1-mini; window 256000,
  maxOutput 32768. Session default: anthropic when ANTHROPIC_API_KEY is set, else openai.
- `loop.ts`: the turn state machine. Owns ChatMessage history; per turn: user.message →
  turn.started → provider stream (message.delta/reasoning.delta with stable per-response ids,
  completed on done; usage.updated with modelContextWindow) → tool rounds: read-only calls run
  concurrently (cap 4), mutating calls sequentially; per call item.updated running→completed/
  failed with the outcome label/output; permission() gates open request.opened
  (requestKind "approval", choices accept/acceptForSession/decline/cancel — the existing A/S/D/C
  UI) and acceptForSession caches by sessionKey; declined/cancelled calls produce isError
  tool_results ("The user declined..."); ask_user opens a "user-input" request whose decision
  becomes the tool result. After mutating calls, `git diff` the mutatedPaths (untracked files via
  `git diff --no-index /dev/null <path>`) → one diff.updated per turn. Max 50 tool rounds per
  turn → warning + forced end. Interrupt aborts the stream/tools → turn.completed interrupted.
  Provider errors → error event (recoverable: true for ProviderHttpError) + turn.completed failed.
- `engine.ts`: `CodesplashDriver` (id "codesplash"): probe() reports available/authenticated from
  present API keys (never echoes key values), detail names the providers found, version =
  APP_VERSION. `CodesplashSession`: capabilities { nativeTranscript: true, approvals: true,
  interrupt: true, resume: false, usage: "tokens", surface: "native" }; nativeSessionId =
  localSessionId; listModels() from the catalog (available providers only); setModel accepts
  `id` or `id:effort` (low|medium|high); send() builds user content (text + images as base64
  ImageBlocks read from disk) and drives the loop; AsyncQueue-based events like the Codex driver.

## TUI wiring (separate task, after engine)

`EngineId` already includes "codesplash". Add the engine to the welcome screen (probe + open),
route session open/new through the same flow as Codex (the session screen and controller are
engine-agnostic), make the status-line engine label dynamic instead of the literal "codex", show
it in --doctor, and record sessions with engine "codesplash". Resume rows for codesplash sessions
stay non-resumable (capabilities.resume false).

## Acceptance

`bun run check` green (biome + tsc + full test suite), including every new module's tests; no
new dependencies in package.json; existing Codex/Claude behavior untouched.
