import { afterEach, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemorySessionState } from "../../../src/core/session/control.ts"
import { NativeCommands } from "../../../src/engines/codesplash/orchestration/commands.ts"
import { createProfile } from "../../../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../../../src/engines/codesplash/sandbox/runtime.ts"
import {
  openSandboxTerminal,
  type SandboxTerminal,
} from "../../../src/engines/codesplash/sandbox/terminal.ts"
import { TerminalFrames, terminalBytes } from "../../../src/engines/codesplash/sandbox/terminal-protocol.ts"

const roots: string[] = [],
  terminals: SandboxTerminal[] = []
afterEach(async () => {
  await Promise.all(terminals.splice(0).map((t) => t.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cs-terminal-")))
  roots.push(root)
  return root
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Terminal condition did not settle")
    await Bun.sleep(10)
  }
}

test("terminal framing is incremental, byte-bounded and rejects forged/incomplete base64", () => {
  const parser = new TerminalFrames(64),
    frames: unknown[] = []
  parser.push(Buffer.from('{"a":"'), (v) => frames.push(v))
  parser.push(Buffer.from('🙂"}\n'), (v) => frames.push(v))
  parser.end()
  expect(frames).toEqual([{ a: "🙂" }])
  expect(() => parser.push(Buffer.alloc(65, 65), () => {})).toThrow("too large")
  expect(() => terminalBytes("aaa=")).toThrow("encoding")
  const incomplete = new TerminalFrames()
  incomplete.push(Buffer.from("{"), () => {})
  expect(() => incomplete.end()).toThrow("Truncated")
})

test("actual sandboxed terminal supports stdin/resize while read/write denials remain enforced", async () => {
  const root = await fixture(),
    outside = await fixture()
  await writeFile(join(outside, "private"), "PRIVATE_DATA")
  let output = ""
  const terminal = await openSandboxTerminal(
    createProfile(root, "read-only"),
    [
      "/bin/sh",
      "-c",
      `test -t 0 && test -t 1 && printf 'TTY_OK\n'; read value; stty size; printf 'INPUT:%s\n' "$value"; if cat '${outside}/private'; then printf 'BAD_READ\n'; else printf 'READ_DENIED\n'; fi; if printf bad > denied; then printf 'BAD_WRITE\n'; else printf 'WRITE_DENIED\n'; fi`,
    ],
    { cols: 80, rows: 24, timeoutMs: 3000 },
    new AbortController().signal,
    (bytes) => {
      output += Buffer.from(bytes).toString()
    },
  )
  terminals.push(terminal)
  await terminal.resize(97, 31)
  await terminal.write(Buffer.from("hello\n"))
  expect((await terminal.finished).kind).toBe("success")
  for (const expected of ["TTY_OK", "31 97", "INPUT:hello", "READ_DENIED", "WRITE_DENIED"])
    expect(output).toContain(expected)
  expect(output).not.toContain("PRIVATE_DATA")
  expect(output).not.toContain("BAD_")
  await expect(terminal.write(Buffer.from("late"))).rejects.toThrow("closed")
})

test("timeouts, explicit close and bounded flooded output settle owned process groups", async () => {
  const root = await fixture()
  const timed = await openSandboxTerminal(
    createProfile(root, "read-only"),
    ["/bin/sh", "-c", "sleep 10"],
    { cols: 80, rows: 24, timeoutMs: 100 },
    new AbortController().signal,
    () => {},
  )
  terminals.push(timed)
  expect((await timed.finished).kind).toBe("timeout")
  let count = 0
  const flooded = await openSandboxTerminal(
    createProfile(root, "read-only"),
    ["/bin/sh", "-c", "yes flood"],
    { cols: 80, rows: 24, timeoutMs: 5000 },
    new AbortController().signal,
    (bytes) => {
      count += bytes.length
    },
  )
  terminals.push(flooded)
  await until(() => count > 65536)
  await flooded.close()
  expect((await flooded.finished).kind).toBe("interrupted")
})

test("command tasks enforce ownership, background waits, private output and monitor cleanup", async () => {
  const root = await fixture(),
    sandbox = new NativeSandbox(createProfile(root, "workspace-write"))
  const commands = new NativeCommands("root", new MemorySessionState(), sandbox, () => "default")
  try {
    const result = await commands.execute(
      { command: 'read value; printf "VALUE:%s\\n" "$value"', background: true },
      {
        cwd: root,
        policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
        signal: new AbortController().signal,
        modelContext: false,
      },
    )
    const id = JSON.parse(result.text).task.id as string
    await until(() => {
      try {
        return commands.output(id).task?.status === "running"
      } catch {
        return false
      }
    })
    const streams = Array.from({ length: 8 }, () => commands.monitor(id))
    expect(() => commands.monitor(id)).toThrow("monitor limit")
    for (const stream of streams) await stream.return?.()
    const monitor = commands.monitor(id)
    const page = monitor.next()
    await until(() => commands.output(id).terminalReady)
    await commands.control({ action: "resize", id, cols: 80, rows: 24 })
    await commands.control({ action: "stdin", id, text: "private-marker\n" })
    expect((await page).value?.text.length).toBeGreaterThan(0)
    await monitor.return?.()
    const finished = (await commands.control({
      action: "wait",
      ids: [id],
      all: true,
      timeoutMs: 3000,
    })) as Array<{ task: { status: string }; output: { text: string } }>
    expect(finished[0]!.task.status).toBe("completed")
    expect(finished[0]!.output.text).toContain("VALUE:private-marker")
    await expect(commands.modelControl({ action: "output", id })).rejects.toThrow("excluded")
    await expect(commands.control({ action: "kill", id: crypto.randomUUID() })).rejects.toThrow("not live")
  } finally {
    await commands.close()
    await sandbox.close()
  }
})

test("reviewed shell snapshots preserve aliases/functions/env within the enforced profile", async () => {
  const root = await fixture(),
    path = join(root, "snapshot.json"),
    definitions = join(root, "definitions.sh")
  const { captureShellSnapshot, reviewShellSnapshot, trustShellSnapshot, shellSnapshotArgv } = await import(
    "../../../src/engines/codesplash/orchestration/shell-state.ts"
  )
  await writeFile(
    definitions,
    "alias greet='printf HELLO'\nannounce() { printf ':%s:%s\\n' \"$M7_LABEL\" \"$1\"; }\n",
  )
  const review = captureShellSnapshot(path, "bash", ["M7_LABEL"], definitions, { M7_LABEL: "fixture" })
  expect(review.snapshot.environment).toEqual({ M7_LABEL: "fixture" })
  expect(() => shellSnapshotArgv(root, review, "greet")).toThrow()
  trustShellSnapshot(root, review)
  let output = ""
  const terminal = await openSandboxTerminal(
    createProfile(root, "read-only"),
    shellSnapshotArgv(root, review, "greet; announce done"),
    { cols: 80, rows: 24, timeoutMs: 3000 },
    new AbortController().signal,
    (bytes) => {
      output += Buffer.from(bytes).toString()
    },
  )
  terminals.push(terminal)
  expect((await terminal.finished).kind).toBe("success")
  expect(output).toContain("HELLO:fixture:done")
  expect(() =>
    captureShellSnapshot(join(root, "bad.json"), "bash", ["BASH_ENV"], undefined, { BASH_ENV: "evil" }),
  ).toThrow("injection")
  await writeFile(definitions, "export API_KEY=sk-fixture-secret-value")
  expect(() => captureShellSnapshot(join(root, "secret.json"), "bash", [], definitions, {})).toThrow(
    "credential",
  )
  await writeFile(path, JSON.stringify({ ...review.snapshot, definitions: "printf CHANGED" }))
  expect(reviewShellSnapshot(path).fingerprint).not.toBe(review.fingerprint)
  expect(() => shellSnapshotArgv(root, review, "greet")).toThrow("changed")
})

test("backgrounding releases the foreground wait while retaining a live owned command", async () => {
  const root = await fixture(),
    sandbox = new NativeSandbox(createProfile(root, "workspace-write"))
  const commands = new NativeCommands("root", new MemorySessionState(), sandbox, () => "default")
  try {
    const running = commands.execute(
      { command: "printf READY; sleep 5", readOnly: true, yieldMs: 30000 },
      {
        cwd: root,
        policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
        signal: new AbortController().signal,
      },
    )
    await until(() => {
      const task = commands.tasks.list()[0]
      return !!task && commands.output(task.id).output.text.includes("READY")
    })
    const id = commands.tasks.list()[0]!.id
    expect(await commands.control({ action: "background" })).toEqual({ backgrounded: [id] })
    expect(JSON.parse((await running).text).task.status).toBe("running")
    await commands.control({ action: "kill", id })
    await commands.control({ action: "wait", ids: [id], all: true, timeoutMs: 3000 })
    expect(commands.tasks.list()[0]!.status).toBe("cancelled")
  } finally {
    await commands.close()
    await sandbox.close()
  }
})

test("closing the terminal reaps background descendants before they can write later", async () => {
  const root = await fixture()
  let output = ""
  const terminal = await openSandboxTerminal(
    createProfile(root, "workspace-write"),
    ["/bin/sh", "-c", "(sleep 0.4; printf leaked > survived) & printf READY; wait"],
    { cols: 80, rows: 24, timeoutMs: 3000 },
    new AbortController().signal,
    (bytes) => {
      output += Buffer.from(bytes).toString()
    },
  )
  terminals.push(terminal)
  await until(() => output.includes("READY"))
  await terminal.close()
  await Bun.sleep(500)
  expect(await Bun.file(join(root, "survived")).exists()).toBe(false)
})

test("interactive redaction releases prompts promptly while withholding split and overlapping secrets", async () => {
  const { SecretSanitizer } = await import("../../../src/engines/codesplash/sandbox/env-policy.ts")
  const secret = new SecretSanitizer(["sdk-super-long-credential", "aba", "bab"], true)
  expect(secret.push("READY> ")).toBe("READY> ")
  expect(secret.push("sdk-super-")).toBe("")
  expect(secret.push("long-credential!")).toBe("[REDACTED]!")
  expect(secret.push("ab")).toBe("")
  expect(secret.push("ab")).toBe("[REDACTED]")
  expect(secret.push("", true)).toBe("")
})

test("an owned terminal cannot read or write a separate host terminal", async () => {
  const root = await fixture()
  let peerText = "",
    output = ""
  const peer = Bun.spawn(["/bin/sh", "-c", "tty; read value"], {
    terminal: {
      data: (_, bytes) => {
        peerText += Buffer.from(bytes).toString()
      },
    },
  })
  try {
    await until(() => peerText.includes("\n"))
    const device = peerText.trim()
    expect(device).toMatch(/^\/dev\/(ttys[0-9]+|pts\/[0-9]+)$/)
    const terminal = await openSandboxTerminal(
      createProfile(root, "read-only"),
      [
        "/bin/sh",
        "-c",
        `if printf BAD_PEER > '${device}'; then printf BAD_WRITE; else printf PEER_WRITE_DENIED; fi; if /bin/sh -c 'exec 3< "$1"' peer '${device}'; then printf BAD_READ; else printf PEER_READ_DENIED; fi; stty size`,
      ],
      { cols: 91, rows: 27, timeoutMs: 3000 },
      new AbortController().signal,
      (bytes) => {
        output += Buffer.from(bytes).toString()
      },
    )
    terminals.push(terminal)
    expect((await terminal.finished).kind).toBe("success")
    expect(output).toContain("PEER_WRITE_DENIED")
    expect(output).toContain("PEER_READ_DENIED")
    expect(output).toContain("27 91")
    expect(peerText).not.toContain("BAD_PEER")
  } finally {
    peer.kill("SIGKILL")
    await peer.exited
    peer.terminal!.close()
  }
})

test("interactive redaction matches whole-text coverage for every small chunk boundary", async () => {
  const { SecretSanitizer } = await import("../../../src/engines/codesplash/sandbox/env-policy.ts")
  const normalize = (text: string) => text.replace(/(?:\[REDACTED\])+/g, "[REDACTED]")
  for (const secrets of [
    ["aba", "bab"],
    ["a", "aa", "baa"],
    ["🙂a", "a🙂"],
    ["abcab", "bc"],
    ["aab", "abb"],
  ]) {
    for (const source of ["abababa", "aaabbaababb", "🙂a🙂a!", "abcabcab!", "READY> ", "baaabaa!"]) {
      const expected = normalize(new SecretSanitizer(secrets).redact(source))
      for (let mask = 0; mask < 1 << (source.length - 1); mask++) {
        const sanitizer = new SecretSanitizer(secrets, true)
        let output = "",
          start = 0
        for (let i = 1; i < source.length; i++)
          if (mask & (1 << (i - 1))) {
            output += sanitizer.push(source.slice(start, i))
            start = i
          }
        output += sanitizer.push(source.slice(start), true)
        expect(normalize(output)).toBe(expected)
      }
    }
  }
})
