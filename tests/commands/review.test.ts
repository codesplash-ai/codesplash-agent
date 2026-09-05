import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildReviewPrompt,
  collectReviewDiff,
  type GitResult,
  type GitRunner,
  parseReviewArguments,
  REVIEW_DIFF_CAP_BYTES,
  runReviewCommand,
} from "../../src/commands/review.ts"
import { UsageError } from "../../src/commands/usage-error.ts"
import {
  type AgentEvent,
  type AgentEventInput,
  AsyncQueue,
  createAgentEvent,
  type EngineCapabilities,
  type EngineDecision,
  type EngineDriver,
  type EngineProbe,
  type EngineSession,
  type OpenSessionOptions,
  readTrustDecision,
  type UserInput,
  writeTrustDecision,
} from "../../src/core/index.ts"

const TIMESTAMP = "2026-01-01T00:00:00.000Z"

const capabilities: EngineCapabilities = {
  nativeTranscript: true,
  approvals: true,
  interrupt: true,
  resume: false,
  usage: "tokens",
  surface: "native",
}

/* ---------------------- scripted fake driver (mirrors cli-run.test.ts) ---------------------- */

type Script = (session: ScriptedSession, input: UserInput) => Promise<void>

class ScriptedSession implements EngineSession {
  readonly localSessionId: string
  readonly nativeSessionId: string
  readonly capabilities = capabilities
  readonly queue = new AsyncQueue<AgentEvent>()
  readonly events = this.queue
  readonly inputs: UserInput[] = []
  readonly decisions: Array<{ requestId: string; decision: EngineDecision }> = []
  closed = false
  readonly #script: Script
  readonly #pendingDecisions = new Map<string, (choice: string) => void>()

  constructor(script: Script, options: OpenSessionOptions) {
    this.#script = script
    this.localSessionId = options.localSessionId
    this.nativeSessionId = options.localSessionId
  }

  emit(event: AgentEvent): void {
    if (!this.closed) this.queue.push(event)
  }

  ask(event: AgentEvent & { kind: "request.opened" }): Promise<string> {
    this.emit(event)
    return new Promise((resolve) => this.#pendingDecisions.set(event.payload.id, resolve))
  }

  async send(input: UserInput): Promise<void> {
    this.inputs.push(input)
    void this.#script(this, input).catch((error) => {
      this.queue.fail(error instanceof Error ? error : new Error(String(error)))
    })
  }

  async resolveRequest(requestId: string, decision: EngineDecision): Promise<void> {
    this.decisions.push({ requestId, decision })
    const settle = this.#pendingDecisions.get(requestId)
    this.#pendingDecisions.delete(requestId)
    settle?.(decision.choice)
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.queue.end()
  }
}

class ScriptedDriver implements EngineDriver {
  readonly id = "codesplash" as const
  openOptions: OpenSessionOptions | undefined
  session: ScriptedSession | undefined

  constructor(readonly script: Script) {}

  async probe(): Promise<EngineProbe> {
    return { available: true, authenticated: true }
  }

  async openSession(options: OpenSessionOptions): Promise<EngineSession> {
    this.openOptions = options
    this.session = new ScriptedSession(this.script, options)
    return this.session
  }
}

function eventFactory(): (input: AgentEventInput) => AgentEvent {
  let sequence = 0
  return (input) =>
    createAgentEvent(
      { engine: "codesplash", localSessionId: "review-1", sequence: sequence++, timestamp: TIMESTAMP },
      input,
    )
}

const findingsScript: Script = async (session) => {
  const ev = eventFactory()
  session.emit(ev({ kind: "turn.started", payload: {} }))
  session.emit(ev({ kind: "message.completed", payload: { id: "m1", text: "No findings." } }))
  session.emit(ev({ kind: "turn.completed", payload: { status: "completed" } }))
}

const approvalScript: Script = async (session) => {
  const ev = eventFactory()
  session.emit(ev({ kind: "turn.started", payload: {} }))
  const choice = await session.ask(
    ev({
      kind: "request.opened",
      payload: {
        id: "req-1",
        requestKind: "approval",
        title: "Run command?",
        detail: "git log",
        choices: ["accept", "decline"],
      },
    }) as AgentEvent & { kind: "request.opened" },
  )
  const text = choice === "accept" ? "ran it" : "skipped it"
  session.emit(ev({ kind: "message.completed", payload: { id: "m1", text } }))
  session.emit(ev({ kind: "turn.completed", payload: { status: "completed" } }))
}

/** Driver that must never be reached (empty diffs and git failures stop before the engine). */
const poisonedDriver: EngineDriver = {
  id: "codesplash",
  probe: async () => ({ available: true }),
  openSession: async () => {
    throw new Error("the engine must not be opened for this review")
  },
}

/* ----------------------------------------- fixtures ----------------------------------------- */

class Sink {
  text = ""

  write(chunk: string): boolean {
    this.text += chunk
    return true
  }
}

const cleanups: string[] = []

afterAll(async () => {
  for (const path of cleanups) await rm(path, { recursive: true, force: true })
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(dir)
  return dir
}

const ok = (stdout: string): GitResult => ({ exitCode: 0, stdout, stderr: "" })

/** Fake git keyed by joined argv; records every invocation. Unknown commands fail loudly. */
function fakeGit(responses: Record<string, GitResult>): GitRunner & { calls: string[][] } {
  const calls: string[][] = []
  return Object.assign(
    async (args: string[], _cwd: string): Promise<GitResult> => {
      calls.push(args)
      return (
        responses[args.join(" ")] ?? {
          exitCode: 128,
          stdout: "",
          stderr: `fatal: unscripted git invocation: git ${args.join(" ")}`,
        }
      )
    },
    { calls },
  )
}

const TRACKED_DIFF = [
  "diff --git a/tracked.ts b/tracked.ts",
  "--- a/tracked.ts",
  "+++ b/tracked.ts",
  "@@ -1 +1 @@",
  "-old line",
  "+new line",
  "",
].join("\n")

const UNTRACKED_DIFF = [
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1 @@",
  "+brand new",
  "",
].join("\n")

function uncommittedGit(): GitRunner & { calls: string[][] } {
  return fakeGit({
    "diff HEAD": ok(TRACKED_DIFF),
    "status --porcelain --untracked-files=all": ok(" M tracked.ts\n?? new.txt\n"),
    "diff --no-index -- /dev/null new.txt": { exitCode: 1, stdout: UNTRACKED_DIFF, stderr: "" },
  })
}

type Fixture = {
  projectDir: string
  dataDir: string
  env: NodeJS.ProcessEnv
  stdout: Sink
  stderr: Sink
}

/** Fixtures are trusted by default so tests that assert exact stderr stay quiet. */
async function makeFixture(options: { trusted?: boolean } = {}): Promise<Fixture> {
  const projectDir = await makeTempDir("codesplash-review-project-")
  const dataDir = await makeTempDir("codesplash-review-data-")
  if (options.trusted !== false) await writeTrustDecision(projectDir, true, dataDir)
  return {
    projectDir,
    dataDir,
    env: {
      CODESPLASH_AGENT_CONFIG_DIR: await makeTempDir("codesplash-review-config-"),
      CODESPLASH_AGENT_DATA_DIR: dataDir,
      ANTHROPIC_API_KEY: "test-not-a-real-key",
    },
    stdout: new Sink(),
    stderr: new Sink(),
  }
}

/* ------------------------------------------ parsing ------------------------------------------ */

/** Fields every parsed ReviewCommand carries when no permission flag is passed. */
const permissionDefaults = {
  permissionMode: undefined,
  allowRules: [],
  askRules: [],
  denyRules: [],
  trust: false,
}

describe("parseReviewArguments", () => {
  test("defaults to uncommitted text review", () => {
    expect(parseReviewArguments([])).toEqual({
      path: undefined,
      mode: { kind: "uncommitted" },
      model: undefined,
      outputFormat: "text",
      auto: false,
      ...permissionDefaults,
    })
  })

  test("parses each mode, the path, and the flags", () => {
    expect(parseReviewArguments(["--uncommitted"]).mode).toEqual({ kind: "uncommitted" })
    expect(parseReviewArguments(["--base", "main"]).mode).toEqual({ kind: "base", ref: "main" })
    expect(parseReviewArguments(["--commit=abc123"]).mode).toEqual({ kind: "commit", sha: "abc123" })
    expect(
      parseReviewArguments(["/tmp/x", "--model", "m:high", "--output-format", "json", "--auto"]),
    ).toEqual({
      path: "/tmp/x",
      mode: { kind: "uncommitted" },
      model: "m:high",
      outputFormat: "json",
      auto: true,
      ...permissionDefaults,
    })
  })

  test("parses --permission-mode, permission rules, and --trust", () => {
    const parsed = parseReviewArguments([
      "--permission-mode=plan",
      "--allow",
      "bash(git log *)",
      "--ask=web_fetch(example.com)",
      "--deny",
      "read_file(**/*.pem)",
      "--trust",
    ])
    expect(parsed.permissionMode).toBe("plan")
    expect(parsed.allowRules).toEqual(["bash(git log *)"])
    expect(parsed.askRules).toEqual(["web_fetch(example.com)"])
    expect(parsed.denyRules).toEqual(["read_file(**/*.pem)"])
    expect(parsed.trust).toBe(true)
  })

  test("permission flag misuse is a usage error with a pointer at what would work", () => {
    expect(() => parseReviewArguments(["--permission-mode", "bypass"])).toThrow("--bypass-approvals")
    expect(() => parseReviewArguments(["--permission-mode", "yolo"])).toThrow(
      "--permission-mode expects plan, default, or accept-edits, got yolo",
    )
    expect(() => parseReviewArguments(["--allow", "Bash(x)"])).toThrow('invalid rule "Bash(x)"')
    expect(() => parseReviewArguments(["--deny"])).toThrow("--deny expects a permission rule")
    expect(() => parseReviewArguments(["--bypass-approvals"])).toThrow(UsageError)
    expect(() => parseReviewArguments(["--bypass-approvals"])).toThrow(
      "review approves with --auto; dangerous commands are always declined headlessly",
    )
  })

  test("the three modes are mutually exclusive", () => {
    expect(() => parseReviewArguments(["--uncommitted", "--base", "main"])).toThrow(UsageError)
    expect(() => parseReviewArguments(["--base", "main", "--commit", "abc"])).toThrow(UsageError)
  })

  test("rejects stream-json, missing values, unknown flags, and extra paths", () => {
    expect(() => parseReviewArguments(["--output-format", "stream-json"])).toThrow(UsageError)
    expect(() => parseReviewArguments(["--base"])).toThrow(UsageError)
    expect(() => parseReviewArguments(["--commit"])).toThrow(UsageError)
    expect(() => parseReviewArguments(["--frobnicate"])).toThrow(UsageError)
    expect(() => parseReviewArguments(["a", "b"])).toThrow(UsageError)
  })
})

/* --------------------------------------- prompt build --------------------------------------- */

describe("buildReviewPrompt", () => {
  test("carries the rubric, the finding format, and the fenced diff", () => {
    const prompt = buildReviewPrompt(TRACKED_DIFF, { kind: "uncommitted" }, false)
    expect(prompt).toContain("senior code review")
    expect(prompt).toContain("READ the surrounding source files with the available tools")
    expect(prompt).toContain("severity (critical|major|minor) · file:line · one-line claim · why it fails")
    expect(prompt).toContain('"No findings."')
    expect(prompt).toContain("uncommitted changes")
    expect(prompt).toContain("````diff")
    expect(prompt).toContain(TRACKED_DIFF)
    expect(prompt).not.toContain("truncated")
  })

  test("labels base and commit modes and appends the truncation note when cut", () => {
    expect(buildReviewPrompt("d", { kind: "base", ref: "main" }, false)).toContain("changes since main")
    expect(buildReviewPrompt("d", { kind: "commit", sha: "abc" }, false)).toContain("commit abc")
    expect(buildReviewPrompt("d", { kind: "uncommitted" }, true)).toContain("truncated at 200KB")
  })
})

/* -------------------------------------- diff collection -------------------------------------- */

describe("collectReviewDiff", () => {
  test("uncommitted combines the tracked diff with --no-index diffs for untracked files", async () => {
    const git = uncommittedGit()
    const result = await collectReviewDiff({ kind: "uncommitted" }, "/repo", git)
    expect(result).toEqual({ diff: `${TRACKED_DIFF}\n${UNTRACKED_DIFF}` })
    expect(git.calls[0]).toEqual(["diff", "HEAD"])
    expect(git.calls[1]).toEqual(["status", "--porcelain", "--untracked-files=all"])
    expect(git.calls[2]).toEqual(["diff", "--no-index", "--", "/dev/null", "new.txt"])
  })

  test("unquotes C-quoted untracked paths from porcelain output", async () => {
    const git = fakeGit({
      "diff HEAD": ok(""),
      "status --porcelain --untracked-files=all": ok('?? "with space.txt"\n'),
      "diff --no-index -- /dev/null with space.txt": { exitCode: 1, stdout: UNTRACKED_DIFF, stderr: "" },
    })
    const result = await collectReviewDiff({ kind: "uncommitted" }, "/repo", git)
    expect(result).toEqual({ diff: UNTRACKED_DIFF })
  })

  test("base and commit modes run the spec'd git commands behind --end-of-options", async () => {
    const baseGit = fakeGit({ "diff --end-of-options main...HEAD": ok(TRACKED_DIFF) })
    expect(await collectReviewDiff({ kind: "base", ref: "main" }, "/repo", baseGit)).toEqual({
      diff: TRACKED_DIFF,
    })

    const commitGit = fakeGit({ "show --patch --end-of-options abc123": ok(TRACKED_DIFF) })
    expect(await collectReviewDiff({ kind: "commit", sha: "abc123" }, "/repo", commitGit)).toEqual({
      diff: TRACKED_DIFF,
    })
  })

  test("a ref or sha starting with '-' is never parsed as a git option", async () => {
    // Without --end-of-options, `--commit --output=/path` would make git write the diff to an
    // arbitrary file — an option-injection write from a nominally read-only review.
    const commitGit = fakeGit({})
    await collectReviewDiff({ kind: "commit", sha: "--output=/tmp/pwned" }, "/repo", commitGit)
    expect(commitGit.calls[0]).toEqual(["show", "--patch", "--end-of-options", "--output=/tmp/pwned"])

    const baseGit = fakeGit({})
    await collectReviewDiff({ kind: "base", ref: "--no-index" }, "/repo", baseGit)
    expect(baseGit.calls[0]).toEqual(["diff", "--end-of-options", "--no-index...HEAD"])
  })

  test("git failures come back as error values naming the command, never throws", async () => {
    const git = fakeGit({})
    const result = await collectReviewDiff({ kind: "base", ref: "gone" }, "/repo", git)
    expect(result).toEqual({
      error:
        "git diff --end-of-options gone...HEAD failed: fatal: unscripted git invocation: git diff --end-of-options gone...HEAD",
    })
  })
})

/* ------------------------------------------- e2e ------------------------------------------- */

describe("runReviewCommand (fake git, fake driver)", () => {
  test("runs the reviewer prompt through the headless runner under a read-only sandbox", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(findingsScript)

    const exitCode = await runReviewCommand([fixture.projectDir], {
      driver,
      git: uncommittedGit(),
      env: fixture.env,
      stdout: fixture.stdout,
      stderr: fixture.stderr,
    })

    expect(exitCode).toBe(0)
    expect(fixture.stdout.text).toBe("No findings.\n")
    expect(driver.openOptions?.cwd).toBe(fixture.projectDir)
    expect(driver.openOptions?.policy).toEqual({
      sandbox: "read-only",
      approvalPolicy: "on-request",
      permissionMode: "default",
    })
    expect(driver.openOptions?.workspaceTrusted).toBe(true)
    const prompt = driver.session?.inputs[0]?.text ?? ""
    expect(prompt).toContain(TRACKED_DIFF)
    expect(prompt).toContain(UNTRACKED_DIFF)
    expect(prompt).toContain("uncommitted changes")
  })

  test("an empty diff prints Nothing to review. and never opens the engine", async () => {
    const fixture = await makeFixture()
    const git = fakeGit({
      "diff HEAD": ok(""),
      "status --porcelain --untracked-files=all": ok(""),
    })

    const exitCode = await runReviewCommand([fixture.projectDir], {
      driver: poisonedDriver,
      git,
      env: fixture.env,
      stdout: fixture.stdout,
      stderr: fixture.stderr,
    })

    expect(exitCode).toBe(0)
    expect(fixture.stdout.text).toBe("Nothing to review.\n")
    expect(fixture.stderr.text).toBe("")
  })

  test("a git failure exits 1 with the message on stderr and never opens the engine", async () => {
    const fixture = await makeFixture()

    const exitCode = await runReviewCommand([fixture.projectDir], {
      driver: poisonedDriver,
      git: fakeGit({}),
      env: fixture.env,
      stdout: fixture.stdout,
      stderr: fixture.stderr,
    })

    expect(exitCode).toBe(1)
    expect(fixture.stdout.text).toBe("")
    expect(fixture.stderr.text).toContain("git diff HEAD failed")
  })

  test("an oversized diff is capped with the truncation note before reaching the model", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(findingsScript)
    const hugeDiff = `diff --git a/big b/big\n${"+x".repeat(REVIEW_DIFF_CAP_BYTES)}`

    const exitCode = await runReviewCommand([fixture.projectDir], {
      driver,
      git: fakeGit({
        "diff HEAD": ok(hugeDiff),
        "status --porcelain --untracked-files=all": ok(""),
      }),
      env: fixture.env,
      stdout: fixture.stdout,
      stderr: fixture.stderr,
    })

    expect(exitCode).toBe(0)
    const prompt = driver.session?.inputs[0]?.text ?? ""
    expect(prompt).toContain("truncated at 200KB")
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(REVIEW_DIFF_CAP_BYTES + 4096)
  })

  test("--model validates against the provider registry as a usage error", async () => {
    const good = await makeFixture()
    const driver = new ScriptedDriver(findingsScript)
    const exitCode = await runReviewCommand([good.projectDir, "--model", "claude-sonnet-5:high"], {
      driver,
      git: uncommittedGit(),
      env: good.env,
      stdout: good.stdout,
      stderr: good.stderr,
    })
    expect(exitCode).toBe(0)
    expect(driver.openOptions?.model).toBe("claude-sonnet-5:high")

    const bad = await makeFixture()
    await expect(
      runReviewCommand([bad.projectDir, "--model", "not-a-model"], {
        driver: poisonedDriver,
        git: uncommittedGit(),
        env: bad.env,
        stdout: bad.stdout,
        stderr: bad.stderr,
      }),
    ).rejects.toThrow(UsageError)
  })

  test("--auto accepts approvals; the default declines them with a notice", async () => {
    const auto = await makeFixture()
    const autoDriver = new ScriptedDriver(approvalScript)
    expect(
      await runReviewCommand([auto.projectDir, "--auto"], {
        driver: autoDriver,
        git: uncommittedGit(),
        env: auto.env,
        stdout: auto.stdout,
        stderr: auto.stderr,
      }),
    ).toBe(0)
    expect(autoDriver.session?.decisions).toEqual([{ requestId: "req-1", decision: { choice: "accept" } }])
    expect(auto.stdout.text).toBe("ran it\n")

    const decline = await makeFixture()
    const declineDriver = new ScriptedDriver(approvalScript)
    expect(
      await runReviewCommand([decline.projectDir], {
        driver: declineDriver,
        git: uncommittedGit(),
        env: decline.env,
        stdout: decline.stdout,
        stderr: decline.stderr,
      }),
    ).toBe(0)
    expect(declineDriver.session?.decisions).toEqual([
      { requestId: "req-1", decision: { choice: "decline" } },
    ])
    expect(decline.stdout.text).toBe("skipped it\n")
    expect(decline.stderr.text).toBe("declined: Run command?\n")
  })

  test("--output-format json emits exactly one result object", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(findingsScript)

    const exitCode = await runReviewCommand([fixture.projectDir, "--output-format", "json"], {
      driver,
      git: uncommittedGit(),
      env: fixture.env,
      stdout: fixture.stdout,
      stderr: fixture.stderr,
    })

    expect(exitCode).toBe(0)
    // The result object also carries runner-owned fields (e.g. sessionId); assert only the
    // review-relevant ones so this test does not re-test the runner's contract.
    const parsed = JSON.parse(fixture.stdout.text) as Record<string, unknown>
    expect(parsed.result).toBe("No findings.")
    expect(parsed.turns).toBe(1)
    expect(parsed.status).toBe("completed")
    expect(fixture.stdout.text.trim().split("\n")).toHaveLength(1)
  })

  test("a failed turn propagates the runner's exit code 1", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(async (session) => {
      const ev = eventFactory()
      session.emit(ev({ kind: "turn.started", payload: {} }))
      session.emit(ev({ kind: "error", payload: { message: "provider exploded", recoverable: true } }))
      session.emit(ev({ kind: "turn.completed", payload: { status: "failed" } }))
    })

    const exitCode = await runReviewCommand([fixture.projectDir], {
      driver,
      git: uncommittedGit(),
      env: fixture.env,
      stdout: fixture.stdout,
      stderr: fixture.stderr,
    })

    expect(exitCode).toBe(1)
    expect(fixture.stderr.text).toContain("error: provider exploded")
  })

  test("permission mode and rules pass through to the runner; the sandbox stays read-only", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(findingsScript)

    const exitCode = await runReviewCommand(
      [
        fixture.projectDir,
        "--permission-mode",
        "plan",
        "--allow",
        "bash(git log *)",
        "--deny=read_file(**/*.pem)",
      ],
      { driver, git: uncommittedGit(), env: fixture.env, stdout: fixture.stdout, stderr: fixture.stderr },
    )

    expect(exitCode).toBe(0)
    expect(driver.openOptions?.policy).toEqual({
      sandbox: "read-only",
      approvalPolicy: "on-request",
      permissionMode: "plan",
    })
    expect(driver.openOptions?.permissionOverrides).toEqual({
      allow: ["bash(git log *)"],
      ask: [],
      deny: ["read_file(**/*.pem)"],
    })
  })

  test("an untrusted workspace reviews with a notice; --trust persists the decision", async () => {
    const untrusted = await makeFixture({ trusted: false })
    const untrustedDriver = new ScriptedDriver(findingsScript)
    expect(
      await runReviewCommand([untrusted.projectDir], {
        driver: untrustedDriver,
        git: uncommittedGit(),
        env: untrusted.env,
        stdout: untrusted.stdout,
        stderr: untrusted.stderr,
      }),
    ).toBe(0)
    expect(untrustedDriver.openOptions?.workspaceTrusted).toBe(false)
    expect(untrusted.stderr.text).toContain("Workspace not trusted:")

    const trusted = await makeFixture({ trusted: false })
    const trustedDriver = new ScriptedDriver(findingsScript)
    expect(
      await runReviewCommand([trusted.projectDir, "--trust"], {
        driver: trustedDriver,
        git: uncommittedGit(),
        env: trusted.env,
        stdout: trusted.stdout,
        stderr: trusted.stderr,
      }),
    ).toBe(0)
    expect(trustedDriver.openOptions?.workspaceTrusted).toBe(true)
    expect(trusted.stderr.text).not.toContain("Workspace not trusted")
    expect(await readTrustDecision(trusted.projectDir, trusted.dataDir)).toMatchObject({ trusted: true })
  })
})
