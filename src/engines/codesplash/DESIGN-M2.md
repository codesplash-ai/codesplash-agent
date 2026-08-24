# CodeSplash engine — M1 completion + headless surface (binding spec)

Extends DESIGN.md. Same house rules: no new dependencies, contracts-first, tests for every cap,
`.ts` import extensions, the product is a "harness", biome-format only your own files.

## Module ownership

| Task | Files |
|---|---|
| auth store | `src/engines/codesplash/auth.ts` + `tests/engines/codesplash/auth.test.ts` |
| apply_patch tool | `src/engines/codesplash/tools/apply-patch.ts` + `tests/engines/codesplash/tools-apply-patch.test.ts` |
| headless runner | `src/engines/codesplash/runner.ts` + `tests/engines/codesplash/runner.test.ts` |
| CLI wiring (after the three above) | `src/cli.ts`, `src/doctor.ts`, `src/engines/codesplash/engine.ts` (probe only), `src/engines/codesplash/tools/registry.ts` (one import line), `src/engines/codesplash/index.ts` (exports), `README.md` (usage section), affected tests |

## Auth store (`auth.ts`)

API keys resolve with precedence **env var > stored credential**. Storage is a single JSON file
`<configDir>/credentials.json` (the existing config dir from `src/core/config.ts`), written
atomically with 0600 permissions like config.ts does — no OS keychain in this cut (passing keys
through `security`'s argv would leak them to `ps`; a keychain backend is a later milestone).

- `resolveApiKey(provider: ProviderId): { key: string; source: "env" | "stored" } | undefined`
- `setApiKey(provider, key)` / `deleteApiKey(provider)` — validate non-empty trimmed key.
- `applyStoredCredentials()` — fills `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in `process.env` from
  the store when unset (providers keep reading env; call this before probe/openSession/run).
- Keys NEVER appear in errors, logs, doctor output, or test snapshots; tests use a temp
  CODESPLASH_AGENT_CONFIG_DIR.

## apply_patch tool (`tools/apply-patch.ts`)

The Codex patch envelope, for models trained on it:

```
*** Begin Patch
*** Add File: path
+line...
*** Update File: path
[*** Move to: newpath]
@@ optional context header
 context line
-removed line
+added line
*** Delete File: path
*** End Patch
```

Parser errors and non-applying hunks throw ToolInputError naming the file and the first
non-matching line (exact match first, then whitespace-normalized fallback like edit_file).
Permission/sandbox rules are identical to write_file per affected path (refuse under read-only;
outside-cwd paths need approval; the approval detail lists every touched path). mutatedPaths
lists all touched paths. isReadOnly false. Registered in `builtinTools()` after edit_file with a
description telling the model to prefer edit_file for single small edits. Tests: add/update/
delete/move, multi-hunk update, context mismatch error, whitespace-fallback match, read-only
refusal, outside-cwd approval, mixed multi-file patch.

## Headless runner (`runner.ts`)

`runHeadless(options: HeadlessRunOptions): Promise<number>` (returns the process exit code;
caller calls process.exit). Options: `{ prompt, cwd, model?, effort?, policy, autoApprove,
maxTurns (default 40), outputFormat: "text" | "json" | "stream-json", recorder?, driver? }` —
`driver?: EngineDriver` is injectable so tests run a scripted fake engine, defaulting to
`new CodesplashDriver()`.

Behavior: open session → send prompt → consume events until the turn completes → close.
Approvals: `request.opened` with requestKind "approval" resolves immediately — "accept" when
autoApprove, else "decline" (and a stderr notice `declined: <title>` once per request);
requestKind "user-input" always resolves "cancel" with a stderr notice (headless runs cannot
interview the user). Multi-turn: the model finishing a turn ends the run (one prompt, one turn).
SIGINT → interrupt → exit 130.

Output formats:
- `text` — assistant text deltas to stdout as they stream; tool labels and status to stderr.
- `json` — nothing until the end, then one JSON object
  `{ result, turns: 1, usage: {inputTokens?, outputTokens?, totalTokens?}, status }` on stdout.
- `stream-json` — every AgentEvent as one JSON line on stdout (the recorder-shaped event,
  raw field stripped), then a final `{"type":"result","result":...,"status":...,"usage":...}` line.

Exit codes: 0 completed; 1 turn failed / provider error; 130 interrupted. (Usage errors exit 2
from the CLI layer, not the runner.) Session recording follows the same recorder rules as the
TUI (respects --no-history) — the CLI layer passes the recorder in.

## CLI wiring (`src/cli.ts` — hand-rolled parser gains its first subcommands)

```
codesplash login <anthropic|openai> [--api-key <key>]   # no flag → read key from stdin (no echo when tty)
codesplash logout <anthropic|openai>
codesplash run [path] [-p|--prompt <text>] [--model <id[:low|medium|high]>]
              [--output-format text|json|stream-json] [--auto] [--max-turns N]
              [--sandbox read-only|workspace-write] [--no-history]
```

- `run` prompt sources: --prompt, else remaining positional text, else piped stdin; empty → usage
  error exit 2. `--full-access` is rejected in run mode ("interactive sessions only") — the typed
  confirmation is the harness's safety signature and cannot happen headless.
- Existing default TUI behavior, flags, and smoke flags are untouched; unknown-flag handling and
  the help text gain the new subcommands.
- `--doctor` adds a codesplash line: which providers have credentials (source env/stored — never
  the values).
- README gets a short "Native engine" usage section (login, run, output formats).
- Tests: CLI arg parsing for every new form (usage errors exit 2), login/logout round-trip
  against a temp config dir, run e2e against the injectable fake driver covering all three output
  formats, decline-vs-auto approval paths, and exit codes.

## Acceptance

`bun run check` green; no new dependencies; TUI flows and existing tests untouched except where
the spec above says otherwise.
