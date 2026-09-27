import { expect, test } from "bun:test"
import { chmodSync, existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { publicMarkdown } from "../../scripts/build-docs.ts"
import { agentDraft, generateAgentCommand } from "../../src/commands/agent-draft.ts"
import { SchedulerService, schedulerServicePlan } from "../../src/core/services/scheduler.ts"
import { relayUnixSocket } from "../../src/core/services/unix-relay.ts"
import { childTranscript, recordedChildren } from "../../src/core/session/children.ts"
import { control, updateControl } from "../../src/core/session/control.ts"
import {
  parseAgentMarkdown,
  validateAgentsConfig,
} from "../../src/engines/codesplash/orchestration/definitions.ts"

const temporary = async () => realpath(await mkdtemp(join(tmpdir(), "cs-followup-")))
test("generated definitions accept only prose, remain disabled and cannot overwrite reviewed files", async () => {
  const root = await temporary()
  try {
    const response = JSON.stringify({
      description: 'Review "carefully"\nwith evidence',
      prompt: "Review changes and cite findings.",
    })
    const text = agentDraft("reviewer", response)
    expect(parseAgentMarkdown(text, "reviewer")).toMatchObject({ enabled: false, mode: "plan", mcp: "none" })
    expect(() =>
      agentDraft("reviewer", JSON.stringify({ description: "x", prompt: "y", enabled: true })),
    ).toThrow()
    expect(() => agentDraft("../outside", response)).toThrow()
    const options = { cwd: root, output() {}, generate: async () => response }
    await generateAgentCommand(["reviewer", "review changes", "--model", "fixture", "--write"], options)
    await expect(
      generateAgentCommand(["reviewer", "replace", "--model", "fixture", "--write"], options),
    ).rejects.toThrow("overwrite")
    expect(await Bun.file(join(root, ".codesplash/agents/reviewer.md")).text()).toBe(text)
    expect(validateAgentsConfig({ personas: { reviewer: "Check correctness." } }).personas?.reviewer).toBe(
      "Check correctness.",
    )
    expect(() => validateAgentsConfig({ personas: { reviewer: "x".repeat(4097) } })).toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("child inspection follows owned nested journals, pages long messages and excludes provider-private blocks", async () => {
  const root = await temporary(),
    id = crypto.randomUUID(),
    task = crypto.randomUUID(),
    parent = crypto.randomUUID()
  try {
    const childRoot = join(root, "children", id)
    await mkdir(childRoot, { recursive: true })
    updateControl(root, control(root).revision, "fixture", (state) => {
      state.values.children = [{ task, identity: { id, root: parent, agent: "builtin/explore" } }]
    })
    const records = recordedChildren(root, parent)
    expect(records).toHaveLength(1)
    const source = `${JSON.stringify({
      v: 1,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "PRIVATE_CANARY", signature: "signature" },
          { type: "text", text: "a".repeat(20000) },
          { type: "tool_call", id: "call", name: "read_file", input: { path: "example" } },
        ],
      },
    })}\nnull\n{torn`
    await Bun.write(join(childRoot, "transcript.jsonl"), source)
    const page = childTranscript(records[0]!, 0, 1)
    expect(page.next).toBe(1)
    expect(page.total).toBe(3)
    expect(page.skipped).toBe(2)
    expect(page.rows[0]?.text.length).toBe(16384)
    const next = childTranscript(records[0]!, 1, 2, page.fingerprint)
    expect(next.next).toBeUndefined()
    expect(next.rows[0]?.text.length).toBe(3616)
    expect(next.rows[1]?.text).toContain('"path":"example"')
    expect(JSON.stringify([page, next])).not.toContain("PRIVATE_CANARY")
    await Bun.write(join(childRoot, "transcript.jsonl"), source + "\n")
    expect(() => childTranscript(records[0]!, 1, 1, page.fingerprint)).toThrow("changed")
    expect(() => recordedChildren(root, crypto.randomUUID())).toThrow("identity")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("user scheduler service plans preserve literal arguments and lifecycle refuses changed owned files", async () => {
  const root = await temporary(),
    calls: string[][] = []
  try {
    for (const platform of ["darwin", "linux"] as const) {
      const home = join(root, platform)
      await mkdir(home)
      const options = {
        cwd: root,
        home,
        dataRoot: join(home, "data"),
        platform,
        uid: 123,
        run: async (args: string[]) => {
          calls.push(args)
          return "active"
        },
      }
      const executable = join(root, "binary space%$x"),
        configRoot = join(root, "config"),
        model = "local/model"
      const plan = schedulerServicePlan({ ...options, executable, configRoot, model })
      expect(plan.args).not.toContain("--approve")
      if (platform === "linux") {
        expect(plan.content).toContain("space%%$$x")
        expect(plan.content).toContain(`WorkingDirectory=${root}\n`)
      } else expect(plan.content).toContain("<key>KeepAlive</key><true/>")
      const service = new SchedulerService(options)
      await service.install(executable, configRoot, model)
      await service.control("start")
      await service.control("status")
      const original = await Bun.file(plan.file).text()
      await Bun.write(plan.file, original + "changed")
      await expect(service.control("uninstall")).rejects.toThrow("changed")
      expect(existsSync(plan.file)).toBe(true)
      await Bun.write(plan.file, original)
      await service.control("uninstall")
      expect(existsSync(plan.file)).toBe(false)
    }
    expect(calls.some((c) => c.includes("bootstrap"))).toBe(true)
    expect(calls.some((c) => c.includes("--now") && c.includes("enable"))).toBe(true)
    expect(() =>
      schedulerServicePlan({
        platform: "linux",
        cwd: root,
        home: root,
        dataRoot: root,
        configRoot: root,
        executable: "/x\nExecStart=bad",
        model: "local",
      }),
    ).toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")(
  "Unix relay half-closes requests, drains replies, bounds bytes and refuses public sockets",
  async () => {
    const root = await temporary(),
      path = join(root, "relay.sock")
    // Independent Node peer verifies real POSIX half-close semantics, not Bun's emulation.
    const server = Bun.spawn(
      [
        "node",
        "-e",
        `
      const net = require("node:net");
      net.createServer({allowHalfOpen:true}, socket => {
        socket.on("error", () => {});
        let data = "";
        socket.on("data", chunk => data += chunk);
        socket.on("end", () => socket.end("reply:" + data));
      }).listen(process.argv[1], () => process.stdout.write("ready\\n"));
    `,
        path,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const reader = server.stdout.getReader()
    await reader.read()
    reader.releaseLock()
    chmodSync(path, 0o600)
    let result = ""
    const sink = () =>
      new Writable({
        write(chunk, _encoding, callback) {
          result += chunk.toString()
          callback()
        },
      })
    try {
      expect(
        (await relayUnixSocket(path, Readable.from(["one", "two"]), sink(), { timeoutMs: 3000 })).transferred,
      ).toBe(18)
      expect(result).toBe("reply:onetwo")
      await expect(
        relayUnixSocket(path, Readable.from(["too much"]), sink(), { maxBytes: 2 }),
      ).rejects.toThrow("byte limit")
      chmodSync(path, 0o666)
      await expect(relayUnixSocket(path, Readable.from(["no"]), sink())).rejects.toThrow("private")
    } finally {
      server.kill()
      await server.exited
      await rm(root, { recursive: true, force: true })
    }
  },
  10000,
)

test("public docs render navigable allowlisted links and tables without active Markdown content", () => {
  const html = publicMarkdown(
    "# Title\n\n[controls](agent-carryovers.md) [private](private/roadmap.md) [bad](javascript:alert)\n\n| Name | Status |\n|---|---|\n| **a** | `done` |\n\n- one\n- two\n<script>alert(1)</script>",
    "docs/agent-roadmap-status.md",
  )
  expect(html).toContain('href="docs-agent-carryovers.html"')
  expect(html).not.toContain('href="private')
  expect(html).not.toContain('href="javascript:')
  expect(html).toContain("<table>")
  expect(html).toContain("<ul><li>one</li><li>two</li></ul>")
  expect(html).not.toContain("<script>")
})
