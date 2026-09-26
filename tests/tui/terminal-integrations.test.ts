import { expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  minimalTerminalEnvironment,
  reviewTerminalIntegrations,
  runTerminalCommand,
  terminalText,
  trustTerminalIntegrations,
} from "../../src/tui/terminal-integrations.ts"
import { VoiceCapture } from "../../src/tui/voice.ts"

test("terminal commands cap output/time, remove controls and strip inherited credentials", async () => {
  expect(minimalTerminalEnvironment({ PATH: "/bin", SECRET_KEY: "hidden" })).toEqual({ PATH: "/bin" })
  expect(terminalText("good\x1b[31mred\x1b]52;c;bad\x07\r\n")).toBe("goodred  ")
  await expect(
    runTerminalCommand([process.execPath, "-e", "setInterval(()=>{},1000)"], {
      cwd: tmpdir(),
      timeoutMs: 50,
    }),
  ).rejects.toThrow("timed out")
  await expect(
    runTerminalCommand([process.execPath, "-e", "process.stdout.write('x'.repeat(20000))"], {
      cwd: tmpdir(),
      maxBytes: 10,
    }),
  ).rejects.toThrow("limit")
  const output = await runTerminalCommand(
    [
      process.execPath,
      "-e",
      "let s=''; for await(const x of Bun.stdin.stream())s+=new TextDecoder().decode(x); console.log(JSON.parse(s).state)",
    ],
    { cwd: tmpdir(), input: '{"state":"running"}' },
  )
  expect(output.trim()).toBe("running")
})

test("review pins executable/script bytes and dictation stages real WAV pipeline output with cleanup", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "m8-voice-test-")))
  const recorder = join(root, "record.ts"),
    transcriber = join(root, "transcribe.ts"),
    receipt = join(root, "receipt")
  try {
    // Deterministic PCM recording fixture; this tests ownership/transport, not speech recognition.
    await writeFile(
      recorder,
      `import {writeFileSync} from 'node:fs'; const p=process.argv.at(-1); const b=Buffer.alloc(3244); b.write('RIFF'); b.writeUInt32LE(3236,4); b.write('WAVEfmt ',8); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(16000,24); b.writeUInt32LE(32000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(3200,40); writeFileSync(p,b); writeFileSync(${JSON.stringify(receipt)},p);`,
    )
    await writeFile(
      transcriber,
      "import {readFileSync} from 'node:fs'; const b=readFileSync(process.argv.at(-1)); if(b.readUInt32LE(24)!==16000)process.exit(1); console.log('fixture dictated words')",
    )
    const config = {
      version: 1,
      voice: {
        record: [process.execPath, recorder, "{audio}"],
        transcribe: [process.execPath, transcriber, "{audio}"],
      },
    }
    await writeFile(join(root, "terminal-integrations.json"), JSON.stringify(config))
    const reviewed = reviewTerminalIntegrations(root)
    expect(reviewed.trusted).toBe(false)
    await expect(new VoiceCapture().run(root, root, () => {})).rejects.toThrow("Review")
    trustTerminalIntegrations(root, reviewed.fingerprint)
    const phases: string[] = []
    expect(await new VoiceCapture().run(root, root, (phase) => phases.push(phase))).toBe(
      "fixture dictated words",
    )
    expect(phases).toEqual(["recording", "transcribing", "finished"])
    const audio = await readFile(receipt, "utf8")
    expect(await Bun.file(audio).exists()).toBe(false)
    await writeFile(transcriber, "console.log('changed')")
    expect(reviewTerminalIntegrations(root).trusted).toBe(false)
    expect(() => trustTerminalIntegrations(root, reviewed.fingerprint)).toThrow("changed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

test("voice cancellation kills capture, never transcribes, and removes the private audio directory", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "m8-voice-cancel-")))
  try {
    const recorder = join(root, "record.ts"),
      transcriber = join(root, "transcribe.ts"),
      receipt = join(root, "receipt")
    await writeFile(
      recorder,
      `await Bun.write(${JSON.stringify(receipt)}, process.argv.at(-1)); setInterval(()=>{},1000)`,
    )
    await writeFile(transcriber, `await Bun.write(${JSON.stringify(join(root, "unexpected"))},'ran')`)
    await writeFile(
      join(root, "terminal-integrations.json"),
      JSON.stringify({
        version: 1,
        voice: {
          record: [process.execPath, recorder, "{audio}"],
          transcribe: [process.execPath, transcriber, "{audio}"],
        },
      }),
    )
    trustTerminalIntegrations(root, reviewTerminalIntegrations(root).fingerprint)
    const capture = new VoiceCapture(),
      pending = capture.run(root, root, () => {})
    void pending.catch(() => {})
    for (let attempt = 0; attempt < 100 && !(await Bun.file(receipt).exists()); attempt++) await Bun.sleep(10)
    expect(await Bun.file(receipt).exists()).toBe(true)
    capture.cancel()
    await expect(pending).rejects.toThrow("cancelled")
    const path = await readFile(receipt, "utf8")
    expect(await Bun.file(path).exists()).toBe(false)
    expect(await Bun.file(join(root, "unexpected")).exists()).toBe(false)
    expect(capture.phase).toBe("cancelled")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
